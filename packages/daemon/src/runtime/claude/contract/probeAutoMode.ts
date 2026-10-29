/**
 * Probe: how the REAL bundled Claude Code CLI behaves with `permissionMode: 'auto'` behind a
 * custom ANTHROPIC_BASE_URL (our LiteLLM routing), against the local fake API. No network, no
 * cost, no real credentials; the user's ~/.claude is never touched (see harness.ts).
 *
 *   pnpm --filter @acc/daemon exec tsx src/runtime/claude/contract/probeAutoMode.ts [outDir] [case...]
 *
 * Writes one JSON per case (requests with full bodies, SDK messages, canUseTool / hook calls)
 * into outDir (default: a temp dir, printed). Findings: docs/snapshot/20261029_auto-mode.md.
 * This is a probe, not a test: it records what happens and asserts nothing.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { HookCallbackMatcher, Options } from '@anthropic-ai/claude-agent-sdk';
import {
  type ClassifierVerdict as Verdict,
  classifierReply,
  isClassifierRequest,
} from './autoMode';
import type { FakeTurn } from './fakeAnthropic';
import { createCliSandbox, locateBundledCli } from './harness';
import { loadRealSdk, runScenario, type RunScenarioOptions } from './runner';

interface ProbeCase {
  name: string;
  model: string;
  verdict: Verdict;
  turns: (repo: string) => FakeTurn[];
  /** Extra env for the CLI (e.g. CLAUDE_CODE_AUTO_MODE_SERVER=0). */
  env?: Record<string, string>;
  /**
   * Replace our PreToolUse hook (the daemon policy, which asks for every command) with a fixed
   * answer for every tool: 'pass' returns nothing, so the CLI's own decision (the classifier)
   * applies. Omitted: the daemon policy hook runs as in production.
   */
  hook?: 'pass' | 'ask' | 'allow' | 'deny';
  /** Inline flag settings for the CLI (e.g. `autoMode`). */
  settings?: Record<string, unknown>;
  /** Keep the runtime's default permission mode (control case). */
  defaultMode?: boolean;
}

const tool =
  (name: string, input: Record<string, unknown>): FakeTurn =>
  () => ({ content: [{ type: 'tool_use', name, input }] });
const echo: FakeTurn = (req) => ({
  content: [{ type: 'text', text: `results: ${JSON.stringify(req.toolResults)}` }],
});

/** A command our policy sends to approval (not read-only) and the CLI would ask about. */
const npmInstall = tool('Bash', { command: 'npm install left-pad', description: 'install' });
const writeOut = tool('Bash', { command: 'echo hi > out.txt', description: 'write' });

const P = 'claude-sonnet-4-6';
const CASES: ProbeCase[] = [
  // Our production hook (asks for every command) under auto mode.
  { name: 'policyhook-allow', model: P, verdict: 'allow', turns: () => [npmInstall, echo] },
  // Hook passes: the CLI decides (server review, then its own classifier).
  { name: 'pass-allow', model: P, verdict: 'allow', hook: 'pass', turns: () => [npmInstall, echo] },
  { name: 'pass-block', model: P, verdict: 'block', hook: 'pass', turns: () => [npmInstall, echo] },
  {
    name: 'pass-block-x4',
    model: P,
    verdict: 'block',
    hook: 'pass',
    turns: () => [npmInstall, npmInstall, npmInstall, npmInstall, echo],
  },
  {
    name: 'pass-garbage',
    model: P,
    verdict: 'garbage',
    hook: 'pass',
    turns: () => [npmInstall, echo],
  },
  {
    name: 'pass-write-allow',
    model: P,
    verdict: 'allow',
    hook: 'pass',
    turns: () => [writeOut, echo],
  },
  {
    name: 'pass-edit-inside',
    model: P,
    verdict: 'block',
    hook: 'pass',
    turns: (repo) => [
      tool('Edit', { file_path: join(repo, 'README.md'), old_string: 'hello', new_string: 'hi' }),
      echo,
    ],
  },
  {
    name: 'pass-git-hook-write',
    model: P,
    verdict: 'allow',
    hook: 'pass',
    turns: (repo) => [
      tool('Write', {
        file_path: join(repo, '.git', 'hooks', 'pre-commit'),
        content: '#!/bin/sh\necho probe\n',
      }),
      echo,
    ],
  },
  {
    name: 'pass-write-outside',
    model: P,
    verdict: 'allow',
    hook: 'pass',
    turns: (repo) => [
      tool('Write', { file_path: join(repo, '..', 'outside', 'new.txt'), content: 'x' }),
      echo,
    ],
  },
  {
    name: 'pass-settings-automode',
    model: P,
    verdict: 'allow',
    hook: 'pass',
    settings: {
      autoMode: {
        environment: [
          '$defaults',
          'Host containment: PROBE-ENVIRONMENT-ENTRY isolated git worktree',
        ],
        soft_deny: ['$defaults', 'PROBE-SOFT-DENY-ENTRY never touch the integration branch'],
      },
    },
    turns: () => [npmInstall, echo],
  },
  {
    name: 'hookask-allow',
    model: P,
    verdict: 'allow',
    hook: 'ask',
    turns: () => [npmInstall, echo],
  },
  {
    name: 'hookask-block',
    model: P,
    verdict: 'block',
    hook: 'ask',
    turns: () => [npmInstall, echo],
  },
  {
    name: 'hookallow-block',
    model: P,
    verdict: 'block',
    hook: 'allow',
    turns: () => [npmInstall, echo],
  },
  { name: 'hookdeny', model: P, verdict: 'allow', hook: 'deny', turns: () => [npmInstall, echo] },
  {
    name: 'pass-noserver-allow',
    model: P,
    verdict: 'allow',
    hook: 'pass',
    env: { CLAUDE_CODE_AUTO_MODE_SERVER: '0' },
    turns: () => [npmInstall, echo],
  },
  {
    name: 'model-sonnet45',
    model: 'claude-sonnet-4-5',
    verdict: 'allow',
    hook: 'pass',
    turns: () => [npmInstall, echo],
  },
  {
    name: 'model-alias',
    model: 'team-sonnet',
    verdict: 'allow',
    hook: 'pass',
    turns: () => [npmInstall, echo],
  },
  {
    name: 'model-gpt',
    model: 'gpt-5',
    verdict: 'allow',
    hook: 'pass',
    turns: () => [npmInstall, echo],
  },
  {
    name: 'model-sonnet5',
    model: 'claude-sonnet-5',
    verdict: 'allow',
    hook: 'pass',
    turns: () => [npmInstall, echo],
  },
  {
    name: 'model-sonnet5-block',
    model: 'claude-sonnet-5',
    verdict: 'block',
    hook: 'pass',
    turns: () => [npmInstall, echo],
  },
  {
    name: 'model-gpt-block',
    model: 'gpt-5',
    verdict: 'block',
    hook: 'pass',
    turns: () => [npmInstall, echo],
  },
  {
    name: 'model-gpt-classifier-env',
    model: 'gpt-5',
    verdict: 'allow',
    hook: 'pass',
    env: { CLAUDE_CODE_AUTO_MODE_MODEL: 'claude-sonnet-4-6' },
    turns: () => [npmInstall, echo],
  },
  {
    name: 'model-gpt-sonnet-env',
    model: 'gpt-5',
    verdict: 'allow',
    hook: 'pass',
    env: { ANTHROPIC_DEFAULT_SONNET_MODEL: 'team-guard' },
    turns: () => [npmInstall, echo],
  },
  {
    name: 'default-pass',
    model: P,
    verdict: 'allow',
    hook: 'pass',
    defaultMode: true,
    turns: () => [npmInstall, echo],
  },
];

async function main() {
  const cli = locateBundledCli();
  if (!cli) throw new Error('bundled Claude Code CLI not found');
  const real = await loadRealSdk();
  const [outArg, ...only] = process.argv.slice(2);
  const outDir = outArg && outArg !== '-' ? outArg : mkdtempSync(join(tmpdir(), 'acc-auto-probe-'));
  mkdirSync(outDir, { recursive: true });
  for (const c of CASES.filter((x) => only.length === 0 || only.includes(x.name))) {
    let classifierCalls = 0;
    const sb = await createCliSandbox({
      keepBodies: true,
      intercept: (req) => {
        if (!isClassifierRequest(req)) return undefined;
        classifierCalls += 1;
        return classifierReply(req, c.verdict);
      },
    });
    const denied: unknown[] = [];
    try {
      sb.api.script(c.turns(sb.repo));
      const permissionDenied: HookCallbackMatcher = {
        hooks: [
          async (input) => {
            denied.push(input);
            return {};
          },
        ],
      };
      const run: RunScenarioOptions = {
        prompt: 'パッケージを入れてテストして',
        model: c.model,
        timeoutMs: 90_000,
        decide: async () => ({ decision: 'approved' }),
        overrideOptions: (o: Options): Options => {
          const hooks = { ...o.hooks, PermissionDenied: [permissionDenied] };
          if (c.hook) {
            const answer = c.hook;
            hooks.PreToolUse = [
              {
                hooks: [
                  async () =>
                    answer === 'pass'
                      ? {}
                      : {
                          hookSpecificOutput: {
                            hookEventName: 'PreToolUse' as const,
                            permissionDecision: answer,
                            permissionDecisionReason: `probe ${answer}`,
                          },
                        },
                ],
              },
            ];
          }
          return {
            ...o,
            ...(c.defaultMode ? {} : { permissionMode: 'auto' as const }),
            env: { ...o.env, ...c.env },
            ...(c.settings ? { settings: c.settings } : {}),
            hooks,
          };
        },
      };
      const result = await runScenario(sb, cli.path, real, run);
      const init = result.messages.find(
        (m) => (m as { type?: string; subtype?: string }).subtype === 'init',
      ) as { permissionMode?: string; model?: string } | undefined;
      const summary = {
        case: c.name,
        model: c.model,
        verdict: c.verdict,
        initPermissionMode: init?.permissionMode,
        classifierCalls,
        requests: sb.api.requests.map((r) => ({
          path: r.path,
          kind: r.kind,
          model: r.summary.model,
          cls: r.headers['x-claude-code-request-class'],
          beta: r.headers['anthropic-beta'],
          tools: r.summary.tools,
          status: r.status,
        })),
        canUseTool: result.calls.canUseTool.map((x) => ({ tool: x.toolName, result: x.result })),
        preToolUse: result.calls.preToolUse.map((x) => ({ tool: x.toolName, output: x.output })),
        asked: result.asked.map((a) => a.toolName),
        permissionDenied: denied,
        proxyAttempts: sb.proxy.attempts,
        systemMessages: result.messages.filter(
          (m) =>
            (m as { type?: string }).type === 'system' &&
            (m as { subtype?: string }).subtype !== 'init',
        ),
        toolResultsSeenByModel: sb.api.mainRequests.length,
        error: result.error,
        durationMs: result.durationMs,
      };
      writeFileSync(join(outDir, `${c.name}.summary.json`), JSON.stringify(summary, null, 2));
      writeFileSync(
        join(outDir, `${c.name}.full.json`),
        JSON.stringify(
          { bodies: sb.api.bodies, messages: result.messages, proxy: sb.proxy.attempts },
          null,
          2,
        ),
      );
      console.log(
        `${c.name}: mode=${init?.permissionMode} classifier=${classifierCalls} canUseTool=${result.calls.canUseTool.length} denied=${denied.length} err=${result.error ?? '-'}`,
      );
    } finally {
      await sb.cleanup();
    }
  }
  console.log(`out: ${outDir}`);
}

void main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
