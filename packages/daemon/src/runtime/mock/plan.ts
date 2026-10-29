import { z } from 'zod';

/**
 * Machine-readable plan for the mock agent, embedded anywhere in the prompt (task description
 * or user message) as a fenced block:
 *
 * ````md
 * ```acc-mock
 * {
 *   "steps": [
 *     { "type": "say", "text": "テストを追加します" },
 *     { "type": "write", "path": "src/sum.ts", "content": "export const sum = ..." },
 *     { "type": "append", "path": "README.md", "content": "\n- sum を追加\n" },
 *     { "type": "run", "command": "node", "args": ["-e", "process.exit(0)"], "title": "テストを実行" },
 *     { "type": "ask", "title": "価格を FAQ に載せる？", "choices": ["載せる", "載せない"] },
 *     { "type": "check", "path": "src/sum.ts", "contains": "export const sum" },
 *     { "type": "sleep", "ms": 500 },
 *     { "type": "usage", "costUsd": 0.4, "phase": "estimate" },
 *     { "type": "resolve", "strategy": "ours+theirs" },
 *     { "type": "fail", "message": "ビルドが通りませんでした" }
 *   ],
 *   "summary": "sum を追加しました",
 *   "delayScale": 0
 * }
 * ```
 * ````
 *
 * A bare JSON array is accepted as shorthand for `{ "steps": [...] }`. Paths are relative to
 * the workspace. Like any agent, every tool use goes through the run's permission gate: what
 * the project's profile asks about goes to approval (`onReject`), what the daemon's rules
 * deny comes back as a tool error and the mock carries on (`onDeny`, default "continue").
 * `run` never uses a shell: `command` + `args` (`"node"` runs the daemon's own Node binary,
 * so plans are cross-platform). `ask` always asks a human: with the `human.ask` tool (a run
 * whose grant offers it) it asks a question and ends the run there; the answer resumes the
 * session and the rest of the plan runs (kept in memory by the runtime, so not across a
 * daemon restart). Without the tool it is an explicit approval scenario (`onReject`).
 */
const RejectAction = z.enum(['stop', 'continue', 'fail']).default('stop');
/** What to do when the daemon's rules deny a tool use (like a real agent: carry on). */
const DenyActionSchema = z.enum(['stop', 'continue', 'fail']).optional();
export type DenyAction = NonNullable<z.infer<typeof DenyActionSchema>>;

const RelPath = z.string().min(1).max(500);

export const MockStep = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('say'), text: z.string().min(1) }),
  z.strictObject({
    type: z.literal('write'),
    path: RelPath,
    content: z.string(),
    onDeny: DenyActionSchema,
  }),
  z.strictObject({
    type: z.literal('append'),
    path: RelPath,
    content: z.string(),
    onDeny: DenyActionSchema,
  }),
  z.strictObject({
    type: z.literal('run'),
    command: z.string().min(1),
    args: z.array(z.string()).default([]),
    /** Shown in the transcript/activity, e.g. "テストを実行". */
    title: z.string().optional(),
    /** Non-zero exit fails the run unless allowed. */
    allowFailure: z.boolean().default(false),
    timeoutMs: z.int().min(1).max(600_000).default(60_000),
    onReject: RejectAction,
    onDeny: DenyActionSchema,
  }),
  z.strictObject({
    type: z.literal('ask'),
    /** The question (one line). */
    title: z.string().min(1).max(200),
    detail: z.string().max(2000).optional(),
    /** Answers to pick from (human.ask). */
    choices: z.array(z.string().min(1).max(40)).max(4).optional(),
    /** Accept a free-text answer (human.ask; default true). */
    allowText: z.boolean().optional(),
    /** Tool name shown in the approval payload (runs without human.ask). */
    toolName: z.string().min(1).default('MockApproval'),
    onReject: RejectAction,
  }),
  z.strictObject({
    type: z.literal('fail'),
    message: z.string().default('モックの失敗ステップです'),
  }),
  /** Waits as if working; `activity` is what the chip's `now` says meanwhile. */
  z.strictObject({
    type: z.literal('sleep'),
    ms: z.int().min(0).max(600_000),
    activity: z.string().min(1).max(40).optional(),
  }),
  /**
   * Report usage as a runtime does (cost tests): `estimate` (default) counts at once like the
   * mock's own per-call estimates; `final` replaces every estimate of the run so far (the
   * difference is booked as a correction); `component: "classifier"` is an auto mode
   * classifier request (outside that correction).
   */
  z.strictObject({
    type: z.literal('usage'),
    costUsd: z.number().min(0).max(1000),
    inputTokens: z.int().min(0).default(0),
    outputTokens: z.int().min(0).default(0),
    phase: z.enum(['estimate', 'final']).default('estimate'),
    component: z.literal('classifier').optional(),
    source: z.enum(['reported', 'estimated', 'unknown']).default('estimated'),
  }),
  /** Read-only verification: the file exists (and contains `contains`). Fails the run otherwise. */
  z.strictObject({ type: z.literal('check'), path: RelPath, contains: z.string().optional() }),
  /**
   * Resolve merge conflicts deterministically: every conflict hunk becomes ours + theirs
   * (concatenated), only ours, or only theirs. `paths` defaults to the unmerged files of the
   * merge in progress. The mock also does this on its own when it finds unmerged files and
   * the prompt has no plan (an integrator run).
   */
  z.strictObject({
    type: z.literal('resolve'),
    strategy: z.enum(['ours+theirs', 'ours', 'theirs']).default('ours+theirs'),
    paths: z.array(RelPath).optional(),
  }),
  /**
   * Leave an output through the `artifact.publish` tool (the run's grant must allow it), with
   * that method's params: `{ "type": "publish", "kind": "document", "title": "FAQ",
   * "path": "faq.md" }`. A refused publish comes back as a tool error and the mock carries on.
   */
  z.strictObject({
    type: z.literal('publish'),
    kind: z.enum(['document', 'data', 'link', 'files']),
    title: z.string().min(1),
    summary: z.string().optional(),
    content: z.string().optional(),
    format: z.string().optional(),
    path: z.string().optional(),
    paths: z.array(z.string()).optional(),
    columns: z.array(z.string()).optional(),
    rows: z.array(z.array(z.unknown())).optional(),
    url: z.string().optional(),
  }),
]);
export type MockStep = z.infer<typeof MockStep>;

export const MockPlan = z.strictObject({
  steps: z.array(MockStep).max(500),
  /** Final message. Default: a generated summary of what changed. */
  summary: z.string().optional(),
  /** Multiplies every built-in delay (0 = instant). Explicit `sleep` steps are not scaled. */
  delayScale: z.number().min(0).max(100).optional(),
});
export type MockPlan = z.infer<typeof MockPlan>;

const FENCES = /```acc-mock[^\S\r\n]*\r?\n([\s\S]*?)```/g;

export class MockPlanError extends Error {
  override name = 'MockPlanError';
}

/**
 * The plan in `prompt`, or null when there is no acc-mock block. Throws MockPlanError if
 * invalid. With several blocks the last one wins: an agent's prompt is the task first and the
 * latest message after it (`## 追加の指示`), so a new plan sent to a working child replaces
 * the one of its brief.
 */
export function parseMockPlan(prompt: string): MockPlan | null {
  const m = [...prompt.matchAll(FENCES)].at(-1);
  if (!m) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(m[1]!);
  } catch (err) {
    throw new MockPlanError(`acc-mock ブロックの JSON を読み取れません: ${(err as Error).message}`);
  }
  const r = MockPlan.safeParse(Array.isArray(raw) ? { steps: raw } : raw);
  if (!r.success) {
    const issue = r.error.issues[0];
    const where = issue?.path.length ? `${issue.path.join('.')}: ` : '';
    throw new MockPlanError(
      `acc-mock ブロックの形式が正しくありません（${where}${issue?.message ?? ''}）`,
    );
  }
  return r.data;
}

export type ResolveStrategy = Extract<MockStep, { type: 'resolve' }>['strategy'];

/**
 * Replace every conflict hunk (`<<<<<<<` ours [`|||||||` base] `=======` theirs `>>>>>>>`)
 * by the chosen side(s). Line endings are kept. Returns the text and the number of hunks.
 */
export function resolveConflictMarkers(
  text: string,
  strategy: ResolveStrategy,
): { text: string; hunks: number } {
  const lines = text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
  const out: string[] = [];
  let state: 'none' | 'ours' | 'base' | 'theirs' = 'none';
  let ours: string[] = [];
  let theirs: string[] = [];
  let hunks = 0;
  const is = (line: string, marker: string) => {
    const l = line.replace(/\r?\n$/, '');
    return l === marker || l.startsWith(`${marker} `);
  };
  for (const line of lines) {
    if (state === 'none' && is(line, '<<<<<<<')) {
      state = 'ours';
      ours = [];
      theirs = [];
    } else if (state === 'ours' && is(line, '|||||||')) {
      state = 'base';
    } else if ((state === 'ours' || state === 'base') && is(line, '=======')) {
      state = 'theirs';
    } else if (state === 'theirs' && is(line, '>>>>>>>')) {
      hunks++;
      if (strategy !== 'theirs') out.push(...ours);
      if (strategy !== 'ours') out.push(...theirs);
      state = 'none';
    } else if (state === 'ours') ours.push(line);
    else if (state === 'theirs') theirs.push(line);
    else if (state === 'none') out.push(line);
  }
  if (state !== 'none') out.push(...ours, ...theirs); // unterminated hunk: keep its content
  return { text: out.join(''), hunks };
}

/** The prompt without its acc-mock blocks (what a human would read). */
export function stripMockPlan(prompt: string): string {
  return prompt.replace(FENCES, '').trim();
}
