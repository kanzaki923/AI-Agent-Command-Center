import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import path from 'node:path';
import type { ContentPart } from '@acc/protocol';
import type { AgentEvent, AgentRunInput, AgentRuntime, ApprovalDecision } from '../../contracts';
import { sleep, throwIfAborted } from '../async';
import { askReason, ToolGate } from '../gate';
import { isInside } from '../policy';
import { MOCK_RUNTIME_ID } from '../registry';
import { describeToolActivity, truncate } from '../tools';
import { conflictedFiles } from '../../workspace/git';
import {
  type DenyAction,
  type MockPlan,
  type MockStep,
  parseMockPlan,
  stripMockPlan,
} from './plan';
import { type Permit, STEP_HANDLERS, type StepContext, type StepOutcome } from './steps';

export { execCommand } from './steps';

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

/**
 * Deterministic, offline coding agent for demos and tests. It really works on the
 * workspace: follows an `acc-mock` plan in the prompt (see plan.ts) or, by default, writes a
 * notes file named after the task (`notes/<slug>.md`) and verifies it.
 *
 * Tool uses go through the same gate as real agents (`AgentRunInput.gate`: hard rules, the
 * profile, remembered approvals). A denial comes back as a tool error with the reason, and
 * the mock carries on like a real agent would (`onDeny`); what the gate asks about goes to
 * the approval flow via `canUseTool`.
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

class MockRun implements StepContext {
  private seq = 0;
  private contextChars: number;
  readonly changed = new Map<string, 'created' | 'updated'>();
  private scale = 1;
  readonly gate: ToolGate;

  constructor(
    readonly opts: MockRuntimeOptions,
    readonly input: AgentRunInput,
  ) {
    this.contextChars = input.prompt.length + (input.systemPrompt?.length ?? 0);
    this.gate = input.gate ?? new ToolGate({ cwd: input.cwd, profile: 'careful' });
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

  /** One plan step, by its handler in `steps/` (STEP_HANDLERS). */
  private step(step: MockStep): AsyncGenerator<AgentEvent, StepOutcome, undefined> {
    const handler = STEP_HANDLERS[step.type] as (
      ctx: StepContext,
      s: MockStep,
    ) => AsyncGenerator<AgentEvent, StepOutcome, undefined>;
    return handler(this, step);
  }

  // ---- primitives (StepContext) -------------------------------------------

  async *rejected(
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

  async permit(toolName: string, toolInput: unknown, toolCallId: string): Promise<Permit> {
    const r = this.gate.check({ toolName, input: toolInput, toolUseId: toolCallId });
    if (r.action === 'allow' || r.action === 'defer') return { kind: 'allowed' };
    if (r.action === 'deny') return { kind: 'denied', message: r.message ?? r.policy.reason };
    throwIfAborted(this.input.signal);
    const decision = await this.input.canUseTool({
      toolName,
      input: toolInput,
      category: r.policy.category,
      reason: askReason(r),
    });
    return { kind: 'answered', decision };
  }

  async *denied(
    toolCallId: string,
    toolName: string,
    permit: Extract<Permit, { kind: 'denied' }>,
    action: DenyAction,
  ): AsyncGenerator<AgentEvent, StepOutcome, undefined> {
    yield this.result(toolCallId, toolName, permit.message, true);
    const why = denialSummary(permit.message);
    switch (action) {
      case 'continue':
        yield* this.say(
          `この操作はデーモンの規則で拒否されました（${why}）。この手順は行わずに作業を続けます。`,
        );
        return 'next';
      case 'fail':
        yield* this.say(`この操作はデーモンの規則で拒否されたため、作業を中止します（${why}）。`);
        throw new Error('必要な操作がデーモンの規則で拒否されました');
      case 'stop':
        yield* this.say(
          `この操作はデーモンの規則で拒否されたため、ここで作業を止めます（${why}）。`,
        );
        return 'stop';
    }
  }

  async *toolCall(
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

  result(toolCallId: string, name: string, output: string, isError = false): AgentEvent {
    this.contextChars += output.length;
    return { type: 'tool_result', toolCallId, name, output, isError };
  }

  async *say(text: string): AsyncGenerator<AgentEvent, void, undefined> {
    const messageId = this.nextId('msg');
    yield* this.stream(messageId, text);
    yield { type: 'message', messageId, role: 'assistant', content: [{ type: 'text', text }] };
    yield this.usage(text.length);
  }

  abs(relPath: string): string {
    return path.resolve(this.input.cwd, relPath);
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

  private summary(stopped: boolean): string {
    const files = [...this.changed.entries()].map(
      ([p, kind]) => `- ${p}（${kind === 'created' ? '新規作成' : '更新'}）`,
    );
    const head = stopped ? '途中で作業を止めました。' : '作業が完了しました。';
    if (files.length === 0) return `${head}ファイルの変更はありません。`;
    return `${head}変更したファイル:\n${files.join('\n')}`;
  }
}

/** First sentence of the Japanese part of a denial message. */
function denialSummary(message: string): string {
  const first = message.split('\n')[0] ?? message;
  return first.replace(/^\[AI Agent Command Center\]\s*/, '').split('。')[0] ?? first;
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
