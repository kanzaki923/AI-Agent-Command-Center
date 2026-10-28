import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { ContentPart } from '@acc/protocol';
import type { AgentEvent, AgentRunInput, AgentRuntime, ApprovalDecision } from '../../contracts';
import { abortError, sleep, throwIfAborted } from '../async';
import { allowlistedEnv } from '../env';
import { decideToolPermission, isInside } from '../policy';
import { MOCK_RUNTIME_ID } from '../registry';
import { describeToolActivity, truncate } from '../tools';
import { conflictedFiles } from '../../workspace/git';
import {
  type MockPlan,
  type MockStep,
  type ResolveStrategy,
  parseMockPlan,
  resolveConflictMarkers,
  stripMockPlan,
} from './plan';

export interface MockRuntimeOptions {
  /** Pause between steps (ms). Default 350. */
  stepDelayMs?: number;
  /** Pause between streamed text chunks (ms). Default 18. */
  typingDelayMs?: number;
  /** Characters per streamed chunk. Default 3. */
  chunkSize?: number;
  /** Environment commands are run with (filtered by the allowlist). Default: process.env. */
  parentEnv?: NodeJS.ProcessEnv;
  /** Nominal price used for the estimated usage (USD per million tokens). */
  price?: { inputPerMTok: number; outputPerMTok: number };
}

const DEFAULT_PRICE = { inputPerMTok: 3, outputPerMTok: 15 };
const OUTPUT_TAIL = 4000;

/**
 * Deterministic, offline coding agent for demos and tests. It really works on the
 * workspace: follows an `acc-mock` plan in the prompt (see plan.ts) or, by default, writes a
 * notes file named after the task (`notes/<slug>.md`) and verifies it.
 *
 * Tool uses go through the same policy as real agents (`decideToolPermission`), so commands
 * and anything outside the workspace hit the approval flow via `canUseTool`.
 */
export class MockAgentRuntime implements AgentRuntime {
  readonly id = MOCK_RUNTIME_ID;
  readonly displayName = 'モックエージェント（オフライン）';

  constructor(private readonly opts: MockRuntimeOptions = {}) {}

  async available(): Promise<{ ok: true }> {
    return { ok: true };
  }

  run(input: AgentRunInput): AsyncIterable<AgentEvent> {
    return new MockRun(this.opts, input).events();
  }
}

type StepOutcome = 'next' | 'stop';

class MockRun {
  private seq = 0;
  private contextChars: number;
  private readonly changed = new Map<string, 'created' | 'updated'>();
  private scale = 1;

  constructor(
    private readonly opts: MockRuntimeOptions,
    private readonly input: AgentRunInput,
  ) {
    this.contextChars = input.prompt.length + (input.systemPrompt?.length ?? 0);
  }

  async *events(): AsyncGenerator<AgentEvent, void, undefined> {
    const { input } = this;
    throwIfAborted(input.signal);
    yield { type: 'session', runtimeSessionId: input.resumeSessionId ?? `mock_${input.runId}` };
    yield { type: 'activity', text: '依頼内容を確認中' };

    const parsed = parseMockPlan(input.prompt);
    const plan = parsed ?? (await defaultPlan(input.prompt, input.cwd, input.runId));
    this.scale = plan.delayScale ?? 1;
    await this.pause();

    if (input.resumeSessionId) {
      yield* this.say('前回の作業の続きから再開します。');
    }

    let stopped = false;
    for (const step of plan.steps) {
      throwIfAborted(input.signal);
      const outcome = yield* this.step(step);
      await this.pause();
      if (outcome === 'stop') {
        stopped = true;
        break;
      }
    }

    yield { type: 'activity', text: '作業内容をまとめています' };
    yield* this.say(plan.summary ?? this.summary(stopped));
  }

  // ---- steps ---------------------------------------------------------------

  private async *step(step: MockStep): AsyncGenerator<AgentEvent, StepOutcome, undefined> {
    switch (step.type) {
      case 'say':
        yield* this.say(step.text);
        return 'next';
      case 'write':
      case 'append':
        return yield* this.editFile(step.type, step.path, step.content);
      case 'check':
        yield* this.check(step.path, step.contains);
        return 'next';
      case 'run':
        return yield* this.runCommand(step);
      case 'resolve':
        return yield* this.resolve(step.strategy, step.paths);
      case 'ask': {
        yield* this.say(`確認が必要です: ${step.title}`);
        const decision = await this.input.canUseTool({
          toolName: step.toolName,
          input: { title: step.title, ...(step.detail ? { detail: step.detail } : {}) },
          title: step.title,
        });
        if (decision.decision === 'approved') {
          yield* this.say('承認されました。続けます。');
          return 'next';
        }
        return yield* this.rejected(step.onReject, decision);
      }
      case 'sleep':
        yield { type: 'activity', text: '待機中' };
        await sleep(step.ms, this.input.signal);
        return 'next';
      case 'fail':
        yield* this.say(`問題が発生しました: ${step.message}`);
        throw new Error(step.message);
    }
  }

  private async *editFile(
    kind: 'write' | 'append',
    relPath: string,
    content: string,
  ): AsyncGenerator<AgentEvent, StepOutcome, undefined> {
    const rel = toPosix(relPath);
    const exists = existsSync(this.abs(relPath));
    const toolName = kind === 'write' ? 'Write' : 'Edit';
    const toolInput =
      kind === 'write' ? { file_path: rel, content } : { file_path: rel, append: content };
    const verb = kind === 'append' ? '追記' : exists ? '書き換え' : '作成';
    const call = yield* this.toolCall(`${rel} を${verb}します。`, toolName, toolInput);

    const decision = await this.permit(toolName, toolInput);
    if (decision && decision.decision === 'rejected') {
      yield this.result(call, toolName, '承認されなかったため変更しませんでした', true);
      return yield* this.rejected('stop', decision);
    }

    const abs = this.abs(relPath);
    await mkdir(path.dirname(abs), { recursive: true });
    if (kind === 'write') await writeFile(abs, content, 'utf8');
    else await appendFile(abs, content, 'utf8');
    if (!this.changed.has(rel)) this.changed.set(rel, exists ? 'updated' : 'created');
    const lines = content.split('\n').length - (content.endsWith('\n') ? 1 : 0);
    yield this.result(
      call,
      toolName,
      kind === 'write'
        ? `${rel} に ${lines} 行を書き込みました`
        : `${rel} に ${lines} 行を追記しました`,
    );
    return 'next';
  }

  private async *check(
    relPath: string,
    contains: string | undefined,
  ): AsyncGenerator<AgentEvent, void, undefined> {
    const rel = toPosix(relPath);
    const toolName = contains ? 'Grep' : 'Read';
    const toolInput = contains ? { pattern: contains, path: rel } : { file_path: rel };
    const call = yield* this.toolCall(`${rel} の内容を確認します。`, toolName, toolInput);
    const decision = await this.permit(toolName, toolInput);
    if (decision && decision.decision === 'rejected') {
      yield this.result(call, toolName, '承認されなかったため確認できませんでした', true);
      throw new Error(`確認が承認されませんでした: ${rel}`);
    }
    let text: string | null;
    try {
      text = await readFile(this.abs(relPath), 'utf8');
    } catch {
      text = null;
    }
    if (text === null) {
      yield this.result(call, toolName, `${rel} が見つかりません`, true);
      throw new Error(`確認に失敗しました: ${rel} が見つかりません`);
    }
    if (contains && !text.includes(contains)) {
      yield this.result(call, toolName, `「${contains}」は見つかりませんでした`, true);
      throw new Error(`確認に失敗しました: ${rel} に「${truncate(contains, 40)}」がありません`);
    }
    const lines = text.split('\n').length;
    yield this.result(
      call,
      toolName,
      contains
        ? `${rel}: 「${truncate(contains, 40)}」を確認しました`
        : `${rel}（${lines} 行）を確認しました`,
    );
  }

  /** Rewrite every conflicted file without markers (Read, then Write — both in the workspace). */
  private async *resolve(
    strategy: ResolveStrategy,
    paths: string[] | undefined,
  ): AsyncGenerator<AgentEvent, StepOutcome, undefined> {
    const files = paths ?? (await conflictedFiles(this.input.cwd).catch(() => []));
    if (files.length === 0) {
      yield* this.say('解消が必要なコンフリクトは見つかりませんでした。');
      return 'next';
    }
    const how =
      strategy === 'ours+theirs'
        ? '両方の変更を残す形'
        : strategy === 'ours'
          ? '統合ブランチ側を残す形'
          : 'マージする側を残す形';
    yield* this.say(`${files.length} ファイルのコンフリクトを、${how}で解消します。`);
    for (const f of files) {
      const rel = toPosix(f);
      const readInput = { file_path: rel };
      const call = yield* this.toolCall(`${rel} のコンフリクトを確認します。`, 'Read', readInput);
      const decision = await this.permit('Read', readInput);
      if (decision && decision.decision === 'rejected') {
        yield this.result(call, 'Read', '承認されなかったため確認できませんでした', true);
        return yield* this.rejected('stop', decision);
      }
      let text: string;
      try {
        text = await readFile(this.abs(f), 'utf8');
      } catch {
        yield this.result(call, 'Read', `${rel} が見つかりません`, true);
        continue;
      }
      const resolved = resolveConflictMarkers(text, strategy);
      yield this.result(call, 'Read', `${rel}: コンフリクト ${resolved.hunks} 箇所`);
      if (resolved.hunks === 0) continue;
      const outcome = yield* this.editFile('write', f, resolved.text);
      if (outcome === 'stop') return 'stop';
    }
    return 'next';
  }

  private async *runCommand(
    step: Extract<MockStep, { type: 'run' }>,
  ): AsyncGenerator<AgentEvent, StepOutcome, undefined> {
    const display = [step.command, ...step.args.map(quoteArg)].join(' ');
    const toolInput = { command: display, ...(step.title ? { description: step.title } : {}) };
    const intro = step.title
      ? `${step.title}ため、コマンドを実行します。`
      : 'コマンドを実行します。';
    const call = yield* this.toolCall(intro, 'Bash', toolInput);

    const decision = await this.permit('Bash', toolInput);
    if (decision && decision.decision === 'rejected') {
      yield this.result(call, 'Bash', '承認されなかったため実行しませんでした', true);
      return yield* this.rejected(step.onReject, decision);
    }

    yield { type: 'activity', text: describeToolActivity('Bash', toolInput, this.input.cwd) };
    const { code, output } = await execCommand(step.command, step.args, {
      cwd: this.input.cwd,
      env: allowlistedEnv(this.opts.parentEnv ?? process.env),
      timeoutMs: step.timeoutMs,
      signal: this.input.signal,
    });
    const failed = code !== 0;
    const summary = `終了コード: ${code ?? '不明'}${output ? `\n${output}` : ''}`;
    yield this.result(call, 'Bash', summary, failed);
    if (failed && !step.allowFailure) {
      yield* this.say(`コマンドが失敗しました（終了コード ${code ?? '不明'}）。`);
      throw new Error(`コマンドが失敗しました（終了コード ${code ?? '不明'}）: ${display}`);
    }
    return 'next';
  }

  private async *rejected(
    action: 'stop' | 'continue' | 'fail',
    decision: ApprovalDecision,
  ): AsyncGenerator<AgentEvent, StepOutcome, undefined> {
    const note = decision.note ? `（理由: ${decision.note}）` : '';
    switch (action) {
      case 'continue':
        yield* this.say(`承認されなかったため、この手順は飛ばします${note}。`);
        return 'next';
      case 'fail':
        yield* this.say(`承認されなかったため、作業を中止します${note}。`);
        throw new Error('必要な操作が承認されませんでした');
      case 'stop':
        yield* this.say(`承認されなかったため、ここで作業を止めます${note}。`);
        return 'stop';
    }
  }

  // ---- primitives ----------------------------------------------------------

  /** Policy check; asks for approval only when the policy says so. null = allowed outright. */
  private async permit(toolName: string, toolInput: unknown): Promise<ApprovalDecision | null> {
    const policy = decideToolPermission({ toolName, input: toolInput, cwd: this.input.cwd });
    if (policy.decision === 'allow') return null;
    throwIfAborted(this.input.signal);
    return this.input.canUseTool({ toolName, input: toolInput });
  }

  /** Narrate, then announce a tool call (streamed text + message with the tool_call part). */
  private async *toolCall(
    text: string,
    name: string,
    toolInput: unknown,
  ): AsyncGenerator<AgentEvent, string, undefined> {
    const messageId = this.nextId('msg');
    const toolCallId = this.nextId('tool');
    yield* this.stream(messageId, text);
    const content: ContentPart[] = [
      { type: 'text', text },
      { type: 'tool_call', toolCallId, name, input: toolInput },
    ];
    yield { type: 'message', messageId, role: 'assistant', content };
    yield this.usage(text.length + JSON.stringify(toolInput).length);
    yield { type: 'tool_call', toolCallId, name, input: toolInput };
    yield { type: 'activity', text: describeToolActivity(name, toolInput, this.input.cwd) };
    await this.pause();
    return toolCallId;
  }

  private result(toolCallId: string, name: string, output: string, isError = false): AgentEvent {
    this.contextChars += output.length;
    return { type: 'tool_result', toolCallId, name, output, isError };
  }

  private async *say(text: string): AsyncGenerator<AgentEvent, void, undefined> {
    const messageId = this.nextId('msg');
    yield* this.stream(messageId, text);
    yield { type: 'message', messageId, role: 'assistant', content: [{ type: 'text', text }] };
    yield this.usage(text.length);
  }

  private async *stream(
    messageId: string,
    text: string,
  ): AsyncGenerator<AgentEvent, void, undefined> {
    const size = Math.max(1, this.opts.chunkSize ?? 3);
    const delay = (this.opts.typingDelayMs ?? 18) * this.scale;
    const chars = Array.from(text);
    for (let i = 0; i < chars.length; i += size) {
      throwIfAborted(this.input.signal);
      yield { type: 'text_delta', messageId, text: chars.slice(i, i + size).join('') };
      if (delay > 0) await sleep(delay, this.input.signal);
    }
  }

  /** Estimated usage of one model call: the whole context in, `outputChars` out. */
  private usage(outputChars: number): AgentEvent {
    const price = this.opts.price ?? DEFAULT_PRICE;
    const inputTokens = Math.ceil(this.contextChars / 4) + 400;
    const outputTokens = Math.ceil(outputChars / 4) + 20;
    this.contextChars += outputChars;
    const costUsd = (inputTokens * price.inputPerMTok + outputTokens * price.outputPerMTok) / 1e6;
    return {
      type: 'usage',
      usage: { inputTokens, outputTokens, costUsd, costSource: 'estimated' },
    };
  }

  private pause(): Promise<void> {
    return sleep((this.opts.stepDelayMs ?? 350) * this.scale, this.input.signal);
  }

  private nextId(kind: string): string {
    this.seq += 1;
    return `mock_${kind}_${this.input.runId}_${this.seq}`;
  }

  private abs(relPath: string): string {
    return path.resolve(this.input.cwd, relPath);
  }

  private summary(stopped: boolean): string {
    const files = [...this.changed.entries()].map(
      ([p, kind]) => `- ${p}（${kind === 'created' ? '新規作成' : '更新'}）`,
    );
    const head = stopped ? '途中で作業を止めました。' : '作業が完了しました。';
    if (files.length === 0) return `${head}ファイルの変更はありません。`;
    return `${head}変更したファイル:\n${files.join('\n')}`;
  }
}

// ---- default plan ------------------------------------------------------------

/**
 * What the mock does without an acc-mock block: resolve the merge conflicts when it finds a
 * merge in progress (an integrator run), else keep a notes file for the task.
 */
export async function defaultPlan(prompt: string, cwd: string, runId: string): Promise<MockPlan> {
  const unmerged = await conflictedFiles(cwd).catch(() => []);
  if (unmerged.length > 0) {
    return {
      steps: [{ type: 'resolve', strategy: 'ours+theirs' }],
      summary: `${unmerged.join('、')} のコンフリクトを、両方の変更を残す形で解消しました。`,
    };
  }
  const text = stripMockPlan(prompt);
  const title = taskTitle(text);
  const rel = `notes/${slugify(title)}.md`;
  const exists = isInside(rel, cwd) && existsSync(path.join(cwd, rel));
  const steps: MockStep[] = [
    {
      type: 'say',
      text: `了解しました。「${title}」に取り組みます。作業メモを ${rel} にまとめます。`,
    },
  ];
  if (exists) {
    steps.push({
      type: 'append',
      path: rel,
      content: `- ${runId}: 依頼内容を再確認し、メモを更新しました。\n`,
    });
  } else {
    steps.push({ type: 'write', path: rel, content: noteContent(title, text, runId) });
  }
  steps.push({ type: 'check', path: rel, contains: `# ${title}` });
  return {
    steps,
    summary: `${rel} を${exists ? '更新' : '作成'}しました。差分を確認して、問題がなければ統合してください。`,
  };
}

function noteContent(title: string, prompt: string, runId: string): string {
  const lines = prompt.split(/\r?\n/);
  const body = lines.slice(1).join('\n').trim();
  const criteria = acceptanceCriteria(prompt);
  const parts = [
    `# ${title}`,
    '',
    '## 依頼内容',
    '',
    truncateBlock(stripSection(body, '完了条件') || '（詳しい説明はありません）', 4000),
    '',
  ];
  if (criteria.length > 0) {
    parts.push('## 完了条件', '', ...criteria.map((c) => `- [ ] ${c}`), '');
  }
  parts.push('## 作業ログ', '', `- ${runId}: 依頼内容を確認し、このメモを作成しました。`, '');
  return parts.join('\n');
}

/** First meaningful line, without markdown heading marks or a "タスク:" prefix. */
export function taskTitle(prompt: string): string {
  const first = prompt
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  const t = (first ?? '')
    .replace(/^#+\s*/, '')
    .replace(/^(タスク|task)\s*[:：]\s*/i, '')
    .trim();
  return truncate(t || '作業メモ', 60);
}

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com\d|lpt\d)$/i;

/** File-name-safe slug that keeps Japanese letters ("ログイン画面を作る" stays readable). */
export function slugify(title: string): string {
  let s = title
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '');
  s = Array.from(s).slice(0, 48).join('').replace(/-+$/, '');
  if (!s) return `task-${createHash('sha1').update(title).digest('hex').slice(0, 8)}`;
  return WINDOWS_RESERVED.test(s) ? `${s}-task` : s;
}

/** Bullet items under a "## 完了条件" heading. */
export function acceptanceCriteria(prompt: string): string[] {
  const lines = prompt.split(/\r?\n/);
  const start = lines.findIndex((l) => /^#+\s*完了条件/.test(l.trim()));
  if (start < 0) return [];
  const out: string[] = [];
  for (const l of lines.slice(start + 1)) {
    const t = l.trim();
    if (/^#+\s/.test(t)) break;
    const m = /^[-*]\s+(?:\[[ xX]\]\s+)?(.+)$/.exec(t);
    if (m) out.push(m[1]!.trim());
  }
  return out;
}

function stripSection(body: string, heading: string): string {
  const lines = body.split('\n');
  const start = lines.findIndex((l) => new RegExp(`^#+\\s*${heading}`).test(l.trim()));
  if (start < 0) return body.trim();
  let end = lines.findIndex((l, i) => i > start && /^#+\s/.test(l.trim()));
  if (end < 0) end = lines.length;
  return [...lines.slice(0, start), ...lines.slice(end)].join('\n').trim();
}

function truncateBlock(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}\n…（省略）`;
}

function toPosix(p: string): string {
  return p.split('\\').join('/');
}

function quoteArg(a: string): string {
  return /^[\w./:=@-]+$/.test(a) ? a : JSON.stringify(a);
}

// ---- command execution -----------------------------------------------------------

/** Run a command without a shell. `node` means this daemon's Node binary. */
export function execCommand(
  command: string,
  args: string[],
  opts: { cwd: string; env: Record<string, string>; timeoutMs: number; signal: AbortSignal },
): Promise<{ code: number | null; output: string }> {
  if (opts.signal.aborted) return Promise.reject(abortError(opts.signal));
  const exe = command === 'node' ? process.execPath : command;
  return new Promise((resolve, reject) => {
    let output = '';
    let settled = false;
    const collect = (chunk: Buffer) => {
      output += chunk.toString('utf8');
      if (output.length > OUTPUT_TAIL * 4) output = output.slice(-OUTPUT_TAIL * 2);
    };
    const child = spawn(exe, args, {
      cwd: opts.cwd,
      env: opts.env,
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);

    const finish = (r: { code: number | null; output: string } | Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      opts.signal.removeEventListener('abort', onAbort);
      if (r instanceof Error) reject(r);
      else resolve(r);
    };
    const tail = () => {
      const t = output.trimEnd();
      return t.length > OUTPUT_TAIL ? `…${t.slice(-OUTPUT_TAIL)}` : t;
    };
    const onAbort = () => {
      child.kill();
      finish(abortError(opts.signal));
    };
    const timer = setTimeout(() => {
      child.kill();
      finish({
        code: null,
        output: `${tail()}\nタイムアウトしました（${opts.timeoutMs}ms）`.trim(),
      });
    }, opts.timeoutMs);
    opts.signal.addEventListener('abort', onAbort, { once: true });

    child.on('error', (err) =>
      finish({ code: null, output: `コマンドを起動できません: ${err.message}` }),
    );
    child.on('close', (code) => finish({ code, output: tail() }));
  });
}
