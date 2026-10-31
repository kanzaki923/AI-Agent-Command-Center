import type { ContentPart, Message } from '@acc/protocol';
import { toolNameForMethod } from './tools';
import type { ChatMessage, ChatToolCall } from './types';

/**
 * Label of the app's note for a run (the status that goes after the history) where a provider
 * cannot take a system message there and it travels as a user turn (Anthropic).
 */
export const APP_NOTE_LABEL = '[アプリから]';

/**
 * How many of the latest `total` messages a run sends: at most `max`, cut in steps of half of
 * it. The start moves only once every `max / 2` new messages, so the runs in between send the
 * same history and the prompt cache reads it back; cut one at a time, every run sent it all
 * again (real API: docs/snapshot/20261031_supervisor-window-cache.md).
 */
export function windowLength(total: number, max: number): number {
  if (total <= max) return total;
  const step = Math.max(1, Math.floor(max / 2));
  return total - Math.ceil((total - max) / step) * step;
}

/**
 * Where the last run of later system messages starts (-1 if none): what changes per run (the
 * status of the trees) comes last, so the history before it is what the next run sends again.
 * An earlier one (a resume notice in the history) must not pin that point.
 */
export function lastLaterSystem(messages: readonly { role: string }[]): number {
  let leading = 0;
  while (messages[leading]?.role === 'system') leading++;
  for (let i = messages.length - 1; i >= leading; i--) {
    if (messages[i]!.role !== 'system') continue;
    while (i - 1 >= leading && messages[i - 1]!.role === 'system') i--;
    return i;
  }
  return -1;
}

/** The latest messages of a history (windowLength). */
export function historyWindow<T>(history: T[], max: number): T[] {
  return history.slice(history.length - windowLength(history.length, max));
}

/** Max characters of one tool result sent back to the model. */
export const MAX_TOOL_OUTPUT_CHARS = 20_000;

export function textOfParts(content: ContentPart[]): string {
  return content
    .filter((p) => p.type === 'text')
    .map((p) => p.text)
    .join('\n');
}

/** Serialize a tool output for the model (JSON unless already a string), truncated. */
export function stringifyToolOutput(output: unknown, max = MAX_TOOL_OUTPUT_CHARS): string {
  let s: string;
  if (typeof output === 'string') s = output;
  else {
    try {
      s = JSON.stringify(output) ?? 'null';
    } catch {
      s = String(output);
    }
  }
  return s.length > max ? `${s.slice(0, max)}…(truncated ${s.length - max} chars)` : s;
}

function argumentsOf(input: unknown): string {
  if (typeof input === 'string') return input; // unparsable arguments kept verbatim
  try {
    return JSON.stringify(input ?? {});
  } catch {
    return '{}';
  }
}

const MISSING_RESULT = JSON.stringify({
  error: { code: 'no_result', message: 'The tool call did not complete (run was interrupted).' },
});

/**
 * Convert persisted session messages to model messages. Tool-call names are stored with
 * API method names (dots) and mapped to tool names here. The history is repaired so the
 * model API accepts it: every assistant tool call gets a result (a synthetic error if the
 * run was interrupted) and orphan tool results are dropped.
 */
export function toChatMessages(
  history: Message[],
  opts: {
    systemPrompt?: string | null;
    /**
     * The text of a user message as the model hears it, e.g. with who sent it in front
     * (sessions/framing.ts). Default: the text as stored.
     */
    userText?: (m: Message, text: string) => string;
  } = {},
): ChatMessage[] {
  const out: ChatMessage[] = [];
  if (opts.systemPrompt) out.push({ role: 'system', content: opts.systemPrompt });

  let open: Map<string, true> | null = null; // tool calls awaiting results
  // User / system messages written while tool calls were running (a message injected into a
  // busy run): the model saw them after the results, so they go after the results here too.
  let held: ChatMessage[] = [];
  const flushHeld = () => {
    out.push(...held);
    held = [];
  };
  const closeOpen = () => {
    if (open) {
      for (const id of open.keys()) {
        out.push({ role: 'tool', toolCallId: id, content: MISSING_RESULT });
      }
      open = null;
    }
    flushHeld();
  };

  for (const m of history) {
    if (m.role === 'tool') {
      for (const p of m.content) {
        if (p.type !== 'tool_result') continue;
        if (!open?.has(p.toolCallId)) continue; // orphan
        open.delete(p.toolCallId);
        out.push({
          role: 'tool',
          toolCallId: p.toolCallId,
          content: stringifyToolOutput(p.output),
        });
      }
      if (open?.size === 0) {
        open = null;
        flushHeld();
      }
      continue;
    }
    if (m.role === 'user' || m.role === 'system') {
      const stored = textOfParts(m.content);
      if (!stored) continue;
      const text = m.role === 'user' && opts.userText ? opts.userText(m, stored) : stored;
      if (open) held.push({ role: m.role, content: text });
      else out.push({ role: m.role, content: text });
      continue;
    }
    closeOpen();
    // assistant
    const text = textOfParts(m.content);
    const toolCalls: ChatToolCall[] = m.content
      .filter((p) => p.type === 'tool_call')
      .map((p) => ({
        id: p.toolCallId,
        name: toolNameForMethod(p.name),
        arguments: argumentsOf(p.input),
      }));
    if (toolCalls.length > 0) {
      out.push({ role: 'assistant', content: text || null, toolCalls });
      open = new Map(toolCalls.map((t) => [t.id, true as const]));
    } else if (text) {
      out.push({ role: 'assistant', content: text });
    }
  }
  closeOpen();
  return out;
}
