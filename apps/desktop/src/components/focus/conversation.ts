import { type Approval, type Attention, type Message, type Run, type SessionBrief, type WakeItemView } from '@acc/protocol';
import type { StreamingMessage } from '../../daemon/deltas';
import type { ChatMessage } from '../../daemon/sync';
import { type ChatBlock, type ToolCallView, buildChatBlocks } from '../../model/chat';
import type { ToolDecided } from '../../model/permissions';
import { controlMethod, describeControlCall } from '../../lib/tools';

/**
 * What the conversation screen shows (ui-redesign spec §5.2), built on the chat blocks of
 * model/chat.ts: a child's first message becomes the request card (`meta.brief`), a
 * supervisor's wake-up becomes the status card (`meta.wake`), capability lines are gone and a
 * pending approval that has its attention row above the composer is not shown twice.
 */
export type ConversationBlock =
  | Exclude<ChatBlock, { kind: 'grant' }>
  | { kind: 'brief'; id: string; message: ChatMessage; brief: SessionBrief }
  | { kind: 'wake'; id: string; message: ChatMessage; items: WakeItemView[] }
  | {
      /** The moment of delegation (ui-rework spec §4.1): the children a supervisor started. */
      kind: 'plan';
      id: string;
      spawns: ToolCallView[];
      /** The supervisor's reason (orchestrator.recordDecision), when it gave one. */
      rationale: string | null;
      /** Other calls of the same block, shown under the plan as usual. */
      rest: ToolCallView[];
    };

/** What a spawn call asked for, read from its input. */
export interface SpawnRequest {
  title: string;
  goal: string;
  doneWhen: string[];
  workspace: 'none' | 'folder' | 'worktree';
  budgetUsd: number | null;
  /** The character of a speaker (session.spawn `persona`), when it is one. */
  persona: string | null;
}

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

export function spawnRequest(input: unknown): SpawnRequest {
  const o = asRecord(input);
  const ws = asRecord(o.workspace);
  const kind = ws.kind === 'folder' ? 'folder' : ws.kind === 'worktree' ? 'worktree' : 'none';
  return {
    title: typeof o.title === 'string' ? o.title : '',
    goal: typeof o.goal === 'string' ? stripMachineBlocks(o.goal) : '',
    doneWhen: Array.isArray(o.doneWhen) ? o.doneWhen.filter((d): d is string => typeof d === 'string') : [],
    workspace: kind,
    budgetUsd: typeof o.budgetUsd === 'number' ? o.budgetUsd : null,
    persona: typeof o.persona === 'string' && o.persona.trim() ? o.persona.trim() : null,
  };
}

const QUOTE_LINE = /^<<<.*ここ(?:から|まで)>>>$/;

/**
 * A message that passes on others' answers (`meta.kind === 'forward'`): the quotes (whose, and
 * the words without their markers) and the sender's own text, for the screen.
 */
export function forwardedParts(message: Pick<Message, 'content' | 'meta'>): {
  quotes: { sessionId: string; title: string; text: string }[];
  own: string;
} | null {
  if (message.meta?.kind !== 'forward') return null;
  const texts = message.content.filter((p) => p.type === 'text').map((p) => p.text);
  const quotes = message.meta.items.map((item, i) => {
    const lines = (texts[i] ?? '').split('\n');
    if (lines.length >= 2 && QUOTE_LINE.test(lines[0]!) && QUOTE_LINE.test(lines.at(-1)!)) {
      lines.splice(-1, 1);
      lines.splice(0, 1);
    }
    return { ...item, text: lines.join('\n').trim() };
  });
  return { quotes, own: texts.slice(message.meta.items.length).join('\n') };
}

/** The session a spawn call created, from its result (JSON text or object); null until it answered. */
export function spawnedSessionId(output: unknown): string | null {
  let v = output;
  if (Array.isArray(v)) v = v.find((p) => p && typeof p === 'object' && 'text' in p);
  if (v && typeof v === 'object' && 'text' in v) v = v.text;
  if (typeof v === 'string') {
    try {
      v = JSON.parse(v);
    } catch {
      return null;
    }
  }
  const session = asRecord(asRecord(v).session);
  return typeof session.id === 'string' ? session.id : null;
}

/** The reason a supervisor recorded with its plan, if the block has one. */
function rationaleOf(calls: ToolCallView[]): string | null {
  for (const c of calls) {
    if (controlMethod(c.name) !== 'orchestrator.recordDecision') continue;
    const r = asRecord(c.input).rationale;
    if (typeof r === 'string' && r.trim()) return r.trim();
  }
  return null;
}

/**
 * Machine-readable blocks inside a message (the mock runtime's ```acc-mock steps): for the
 * model, never for a person. Removed from what the screen shows.
 */
export function stripMachineBlocks(text: string): string {
  return text
    .replace(/```acc-mock[^\n]*\n[\s\S]*?(?:```|$)/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** The shared wording lives in lib/tools.ts (chat, activity line and timeline say the same). */
export { controlMethod as toolMethod, describeControlCall };

/** Tool calls with the screen's phrases (identity kept when nothing changes). */
function rephrase(calls: ToolCallView[], titleOf: (id: string) => string | undefined): ToolCallView[] {
  let changed = false;
  const out = calls.map((c) => {
    const label =
      describeControlCall(c.name, c.input, titleOf) ??
      (c.desc.category === 'wait' ? '終わるのを待つ' : null);
    if (!label || label === c.desc.label) return c;
    changed = true;
    const category = c.desc.category === 'other' ? 'control' : c.desc.category;
    return { ...c, desc: { ...c.desc, category, label, activity: label, target: null } };
  });
  return changed ? out : calls;
}

export interface ConversationInput {
  messages: ChatMessage[];
  approvals: Approval[];
  streaming: StreamingMessage[];
  runs: Run[];
  decisions?: ReadonlyMap<string, ToolDecided>;
  /** Open attention items of this conversation (approvals among them are answered there). */
  attention: readonly Attention[];
  titleOf?: (sessionId: string) => string | undefined;
}

/** Wake-ups are system messages; they are kept in order by reading them as turns. */
function asTurns(messages: ChatMessage[]): ChatMessage[] {
  let changed = false;
  const out = messages.map((m) => {
    if (m.role === 'system' && m.meta?.kind === 'wake') {
      changed = true;
      return { ...m, role: 'user' as const };
    }
    return m;
  });
  return changed ? out : messages;
}

/** The chat blocks of model/chat.ts for this conversation (before `toConversationBlocks`). */
export function buildBaseBlocks(input: ConversationInput): ChatBlock[] {
  const answered = new Set(input.attention.map((a) => a.refs.approvalId).filter(Boolean));
  return buildChatBlocks({
    messages: asTurns(input.messages),
    // A pending approval with its attention row is answered above the composer only.
    approvals: input.approvals.filter((a) => !(a.status === 'pending' && answered.has(a.id))),
    streaming: input.streaming,
    runs: input.runs,
    decisions: input.decisions,
  });
}

/**
 * Map chat blocks to conversation blocks. `cache` keeps the mapped object of an unchanged
 * (stabilized) block, so memoized rows do not re-render on every streaming frame.
 */
export function toConversationBlocks(
  blocks: ChatBlock[],
  cache: WeakMap<ChatBlock, ConversationBlock>,
  titleOf: (sessionId: string) => string | undefined = () => undefined,
): ConversationBlock[] {
  const out: ConversationBlock[] = [];
  for (const b of blocks) {
    if (b.kind === 'grant') continue;
    const hit = cache.get(b);
    if (hit) {
      out.push(hit);
      continue;
    }
    let mapped: ConversationBlock = b;
    if (b.kind === 'user' && b.message.meta?.kind === 'brief') {
      mapped = { kind: 'brief', id: b.id, message: b.message, brief: b.message.meta.brief };
    } else if (b.kind === 'user' && b.message.meta?.kind === 'wake') {
      mapped = { kind: 'wake', id: b.id, message: b.message, items: b.message.meta.items };
    } else if (b.kind === 'tools') {
      const spawns = b.calls.filter((c) => controlMethod(c.name) === 'session.spawn');
      if (spawns.length > 0) {
        const rest = rephrase(
          b.calls.filter((c) => {
            const m = controlMethod(c.name);
            return m !== 'session.spawn' && m !== 'orchestrator.recordDecision';
          }),
          titleOf,
        );
        mapped = { kind: 'plan', id: b.id, spawns, rationale: rationaleOf(b.calls), rest };
      } else {
        const calls = rephrase(b.calls, titleOf);
        if (calls !== b.calls) mapped = { ...b, calls };
      }
    }
    cache.set(b, mapped);
    out.push(mapped);
  }
  return out;
}
