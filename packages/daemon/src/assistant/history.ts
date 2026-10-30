import type { ContentPart, Message, ToolResultPart } from '@acc/protocol';

/** Longest argument digest kept in a record line. */
const ARGS_MAX = 120;

/** Keys of a tool result worth remembering (the rest of the payload is stale by the next run). */
const RESULT_KEYS = ['id', 'title', 'state', 'nextRunAt', 'stoppedSessionIds', 'resumedSessionIds'];

function digestArgs(input: unknown): string {
  let s: string;
  try {
    s = JSON.stringify(input ?? {});
  } catch {
    s = String(input);
  }
  return s.length > ARGS_MAX ? `${s.slice(0, ARGS_MAX - 1)}…` : s;
}

/** `ok` with the few keys that matter, or the error of the call. */
function digestResult(part: ToolResultPart | undefined): string {
  if (!part) return 'no result';
  const out = part.output;
  if (part.isError || (out && typeof out === 'object' && 'error' in out)) {
    const e = (out as { error?: { message?: string } } | null)?.error;
    return `error: ${e?.message ?? JSON.stringify(out)}`;
  }
  if (!out || typeof out !== 'object') return 'ok';
  const obj = out as Record<string, unknown>;
  const inner =
    obj.session && typeof obj.session === 'object' ? (obj.session as Record<string, unknown>) : obj;
  const kept = RESULT_KEYS.filter((k) => inner[k] !== undefined).map(
    (k) => `${k}=${JSON.stringify(inner[k])}`,
  );
  return kept.length > 0 ? `ok ${kept.join(' ')}` : 'ok';
}

function textOf(parts: ContentPart[]): string {
  return parts
    .filter((p) => p.type === 'text')
    .map((p) => p.text)
    .join('')
    .trim();
}

/**
 * What the assistant remembers of its past runs (right-hand spec; snapshot
 * 20261030_right-hand-real.md): the words, not the payloads. For every run other than the
 * current one, the tool calls of an assistant message become one record line each
 * (`[method args → result]`) inside that message, and the tool-result messages are dropped.
 * The current run keeps its tool exchanges whole (the model acts on them), and the status of
 * every tree comes fresh with the system prompt, so nothing current is lost. Pure.
 */
export function rememberPastRuns(history: readonly Message[], currentRunId: string): Message[] {
  const results = new Map<string, ToolResultPart>();
  for (const m of history) {
    if (m.role !== 'tool') continue;
    for (const p of m.content) if (p.type === 'tool_result') results.set(p.toolCallId, p);
  }
  const out: Message[] = [];
  for (const m of history) {
    const past = !!m.runId && m.runId !== currentRunId;
    if (!past) {
      out.push(m);
      continue;
    }
    if (m.role === 'tool') continue;
    if (m.role !== 'assistant') {
      out.push(m);
      continue;
    }
    const lines = [textOf(m.content)];
    for (const p of m.content) {
      if (p.type !== 'tool_call') continue;
      lines.push(`[${p.name} ${digestArgs(p.input)} → ${digestResult(results.get(p.toolCallId))}]`);
    }
    const text = lines.filter(Boolean).join('\n');
    if (!text) continue;
    out.push({ ...m, content: [{ type: 'text', text }] });
  }
  return out;
}
