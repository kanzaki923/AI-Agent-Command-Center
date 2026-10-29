import type { ContentPart, Message } from '@acc/protocol';
import { toolNameForMethod } from './tools';
import type { ChatMessage, ChatToolCall } from './types';

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
  opts: { systemPrompt?: string | null } = {},
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
      const text = textOfParts(m.content);
      if (!text) continue;
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
