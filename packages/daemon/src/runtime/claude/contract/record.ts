/**
 * Records the raw SDK message streams the unit tests replay (`recorded.ts`), from the REAL
 * Claude Code CLI bundled with the SDK, against the local fake API (no network, no cost).
 *
 *   pnpm --filter @acc/daemon record:sdk-fixtures
 *
 * Re-run after upgrading @anthropic-ai/claude-agent-sdk, then run typecheck and the tests:
 * a shape change shows up as a typecheck error in recorded.ts or a failing unit test.
 *
 * Sanitizing: the sandbox paths become `<REPO>` / `<ROOT>`, any other local absolute path
 * becomes `<LOCAL_PATH>`, session ids become fixed UUIDs, and the long name lists in
 * system/init (slash commands, skills, agents, plugins) are emptied. Credentials never
 * appear (the fake API gets a dummy token and the CLI does not echo it); the recorder
 * refuses to write a file that contains the dummy token, the user / host name or a local path.
 */
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { hostname, userInfo } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Settings } from '@acc/protocol';
import { ClaudeAgentSdkRuntime, MemoryBaselineStore } from '../runtime';
import { createCliSandbox, locateBundledCli, type CliSandbox } from './harness';
import { REPO_PLACEHOLDER, ROOT_PLACEHOLDER } from './recordedTypes';
import {
  DUMMY_TOKEN,
  loadRealSdk,
  playScenario,
  recordingSdk,
  runScenario,
  type SdkCallLog,
} from './runner';
import { type ScenarioName, scenarios } from './scenarios';

const RECORDED: ScenarioName[] = [
  'text',
  'textAlias',
  'editInside',
  'bashApproved',
  'mcp',
  'interruptStream',
  'abortPendingApproval',
  'apiError',
  'authError',
];

/** Tool inputs in one input_json_delta, so the paths in them can be replaced. */
const WHOLE_JSON = { jsonChunkSize: 1_000_000 };

const LIST_KEYS = ['slash_commands', 'terminal_slash_commands', 'skills', 'agents', 'plugins'];

function sanitize(messages: unknown[], sb: CliSandbox, index: number): unknown[] {
  const sessionIds = new Map<string, string>();
  const fixedUuid = (n: number) =>
    `00000000-0000-4000-8000-${String(index * 100 + n).padStart(12, '0')}`;
  const variants = (p: string) => [p, p.replaceAll('\\', '/'), p.replaceAll('\\', '\\\\')];
  const fixString = (s: string): string => {
    let out = s;
    for (const v of variants(sb.repo)) out = out.split(v).join(REPO_PLACEHOLDER);
    for (const v of variants(sb.root)) out = out.split(v).join(ROOT_PLACEHOLDER);
    // The CLI names per-project directories after the path ("C--Users-...").
    out = out.split(sb.root.replace(/[^A-Za-z0-9]/g, '-')).join('<ROOT_SLUG>');
    const sid = sessionIds.get(out);
    if (sid) return sid;
    if (/[A-Za-z]:[\\/]|^\/(Users|home|tmp|var)\//.test(out)) return '<LOCAL_PATH>';
    return out;
  };
  const walk = (v: unknown, key?: string): unknown => {
    if (typeof v === 'string') return fixString(v);
    if (Array.isArray(v)) return key && LIST_KEYS.includes(key) ? [] : v.map((x) => walk(x));
    if (v && typeof v === 'object') {
      return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x, k)]));
    }
    return v;
  };
  for (const m of messages) {
    const sid = (m as { session_id?: unknown }).session_id;
    if (typeof sid === 'string' && !sessionIds.has(sid)) {
      sessionIds.set(sid, fixedUuid(sessionIds.size + 1));
    }
  }
  return messages.map((m) => walk(m));
}

function constName(name: string): string {
  return name.replace(/[A-Z]/g, (c) => `_${c}`).toUpperCase();
}

async function main(): Promise<void> {
  const cli = locateBundledCli();
  if (!cli) throw new Error('The SDK-bundled Claude Code CLI is not installed');
  const version = execFileSync(cli.path, ['--version']).toString().trim();
  const real = await loadRealSdk();
  const out: { name: string; messages: unknown[]; calls?: SdkCallLog }[] = [];

  for (const [i, name] of RECORDED.entries()) {
    const { sb, result } = await playScenario(scenarios[name], cli.path, real, WHOLE_JSON);
    out.push({ name, messages: sanitize(result.messages, sb, i + 1) });
    console.log(
      `${name}: ${result.messages.length} messages${result.error ? ` (${result.error})` : ''}`,
    );
    await sb.cleanup();
  }

  // Resume: the second run's result carries the session's running totals.
  {
    const sb = await createCliSandbox(WHOLE_JSON);
    const baselines = new MemoryBaselineStore();
    const sink = {
      messages: [] as unknown[],
      calls: { canUseTool: [], preToolUse: [] },
      options: [],
    };
    const rt = new ClaudeAgentSdkRuntime({
      settings: () => Settings.parse({ litellm: { baseUrl: sb.api.url, apiKey: DUMMY_TOKEN } }),
      parentEnv: sb.parentEnv,
      pathToClaudeCodeExecutable: cli.path,
      baselines,
      loadSdk: async () => recordingSdk(real, sink),
    });
    sb.api.script([
      () => ({
        content: [{ type: 'text', text: '一回目' }],
        usage: { input_tokens: 1000, output_tokens: 10 },
      }),
    ]);
    const first = await runScenario(sb, cli.path, real, { prompt: '一回目' }, rt);
    const sid = first.events.find((e) => e.type === 'session');
    if (sid?.type !== 'session') throw new Error('no session id');
    const firstMessages = [...sink.messages];
    sink.messages.length = 0;
    sb.api.script([
      () => ({
        content: [{ type: 'text', text: '二回目' }],
        usage: { input_tokens: 2000, output_tokens: 10 },
      }),
    ]);
    await runScenario(
      sb,
      cli.path,
      real,
      { prompt: '二回目', resumeSessionId: sid.runtimeSessionId },
      rt,
    );
    const idx = RECORDED.length + 1;
    out.push({ name: 'resumeFirst', messages: sanitize(firstMessages, sb, idx) });
    out.push({ name: 'resumeSecond', messages: sanitize([...sink.messages], sb, idx) });
    console.log(`resume: ${firstMessages.length} + ${sink.messages.length} messages`);
    await sb.cleanup();
  }

  const body = out
    .map(
      (s) =>
        `export const ${constName(s.name)} = ${JSON.stringify(s.messages, null, 2)} satisfies RecordedStream;\n`,
    )
    .join('\n');
  const file = `// Generated by \`pnpm --filter @acc/daemon record:sdk-fixtures\` (contract/record.ts): raw SDK
// message streams of the real Claude Code CLI against the fake API. Do not edit; re-record.
import type { RecordedStream } from './recordedTypes';

export const RECORDED_CLI_VERSION = ${JSON.stringify(version)};

${body}`;
  for (const f of [DUMMY_TOKEN, userInfo().username, hostname()]) {
    const at = f ? file.indexOf(f) : -1;
    if (at >= 0) {
      throw new Error(
        `refusing to write fixtures containing a secret / user name near: ${JSON.stringify(file.slice(Math.max(0, at - 120), at))}`,
      );
    }
  }
  // A drive-letter path in JSON ("C:\\..." or "C:/...").
  if (/[A-Za-z]:(\\\\|\/)/.test(file)) {
    throw new Error('refusing to write fixtures containing a local path');
  }
  const target = join(dirname(fileURLToPath(import.meta.url)), 'recorded.ts');
  writeFileSync(target, file);
  console.log(`wrote ${target} (CLI ${version})`);
}

await main();
