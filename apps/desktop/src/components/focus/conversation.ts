import { type Approval, type Attention, type Run, type SessionBrief, type WakeItemView, isMethodName } from '@acc/protocol';
import type { StreamingMessage } from '../../daemon/deltas';
import type { ChatMessage } from '../../daemon/sync';
import { type ChatBlock, type ToolCallView, buildChatBlocks } from '../../model/chat';
import type { ToolDecided } from '../../model/permissions';
import { controlMethod, shorten } from '../../lib/tools';

/**
 * What the conversation screen shows (ui-redesign spec §5.2), built on the chat blocks of
 * model/chat.ts: a child's first message becomes the request card (`meta.brief`), a
 * supervisor's wake-up becomes the status card (`meta.wake`), capability lines are gone and a
 * pending approval that has its attention row above the composer is not shown twice.
 */
export type ConversationBlock =
  | Exclude<ChatBlock, { kind: 'grant' }>
  | { kind: 'brief'; id: string; message: ChatMessage; brief: SessionBrief }
  | { kind: 'wake'; id: string; message: ChatMessage; items: WakeItemView[] };

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

/**
 * The Control API method behind a tool name: `session.spawn`, `session__spawn`,
 * `mcp__acc__session__spawn`, and the runtime's single-underscore `mcp__acc__session_spawn`.
 */
export function toolMethod(name: string): string | null {
  const known = controlMethod(name);
  if (known) return known;
  let bare = name;
  if (bare.startsWith('mcp__')) {
    const rest = bare.slice(5);
    const i = rest.indexOf('__');
    bare = i === -1 ? rest : rest.slice(i + 2);
  }
  const dotted = bare.replaceAll('__', '.');
  if (isMethodName(dotted)) return dotted;
  const first = bare.replace('_', '.');
  return isMethodName(first) ? first : null;
}

/** Control API calls in the screen's words (the same as a chip's `now`): no Task / Run / Worker. */
export function describeControlCall(
  name: string,
  input: unknown,
  titleOf: (sessionId: string) => string | undefined = () => undefined,
): string | null {
  const method = toolMethod(name);
  if (!method) return null;
  const o = input && typeof input === 'object' ? (input as Record<string, unknown>) : {};
  const s = (k: string) => (typeof o[k] === 'string' && (o[k]).trim() ? (o[k]).trim() : null);
  const q = (v: string | null, max = 32) => (v ? `「${shorten(v, max)}」` : '');
  const target = s('sessionId') ? titleOf(s('sessionId')!) : undefined;
  switch (method) {
    case 'session.spawn':
      return `${q(s('title')) || '1 人'}に依頼`;
    case 'human.ask':
      return `質問${q(s('question'), 40)}`;
    case 'artifact.publish':
      return `${q(s('title')) || '成果物'}を提出`;
    case 'session.send':
      return target ? `「${shorten(target, 32)}」に伝える` : '伝える';
    case 'session.stop':
      return target ? `「${shorten(target, 32)}」を止める` : '止める';
    case 'session.resume':
      return target ? `「${shorten(target, 32)}」を再開` : '再開';
    case 'attention.respond':
      return '質問に回答';
    case 'artifact.review':
      return s('decision') === 'accept' ? '成果物を採用' : 'やり直しを依頼';
    case 'artifact.read':
    case 'artifact.get':
    case 'artifact.list':
      return '成果物を確認';
    case 'schedule.create':
    case 'schedule.update':
      return '繰り返しを設定';
    case 'schedule.delete':
      return '繰り返しをやめる';
    case 'cost.summary':
    case 'budget.get':
      return '費用を確認';
    case 'task.wait':
    case 'integration.wait':
      return '終わるのを待つ';
    default:
      // Reading the state of the tree, its sessions, runs, tasks...: one phrase for all.
      if (/\.(get|list|tree|messages|summary)$/.test(method) || method === 'home.get') return '状況を確認';
      return null;
  }
}

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
      const calls = rephrase(b.calls, titleOf);
      if (calls !== b.calls) mapped = { ...b, calls };
    }
    cache.set(b, mapped);
    out.push(mapped);
  }
  return out;
}
