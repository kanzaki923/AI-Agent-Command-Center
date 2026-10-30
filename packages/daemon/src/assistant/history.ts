import type { ContentPart, Message, ToolResultPart } from '@acc/protocol';

/** Keys of a tool result worth remembering (the rest of the payload is stale by the next run). */
const RESULT_KEYS = ['id', 'title', 'state', 'nextRunAt', 'stoppedSessionIds', 'resumedSessionIds'];

/** The few keys that matter of a result, or its error; the payload itself is not kept. */
export function digestResult(part: ToolResultPart): unknown {
  const out = part.output;
  if (part.isError || (out && typeof out === 'object' && 'error' in out)) {
    const e = (out as { error?: { message?: string } } | null)?.error;
    return { error: { message: e?.message ?? JSON.stringify(out) } };
  }
  if (!out || typeof out !== 'object') return { ok: true };
  const obj = out as Record<string, unknown>;
  const inner =
    obj.session && typeof obj.session === 'object' ? (obj.session as Record<string, unknown>) : obj;
  const kept: Record<string, unknown> = { ok: true };
  for (const k of RESULT_KEYS) if (inner[k] !== undefined) kept[k] = inner[k];
  return kept;
}

/**
 * What the assistant remembers of its past runs (right-hand spec; snapshot
 * 20261030_right-hand-real.md): the words and the calls, not the payloads. For every run
 * other than the current one, reasoning is dropped and each tool result is cut to its
 * digest (`{ok, id, title, …}` or `{error}`); the calls themselves stay as calls, so the
 * model sees its history in the shape it produces (a textual record would be imitated).
 * The current run keeps its tool exchanges whole (the model acts on them), and the status
 * of every tree comes fresh with the system prompt, so nothing current is lost. Pure.
 */
export function rememberPastRuns(history: readonly Message[], currentRunId: string): Message[] {
  const out: Message[] = [];
  for (const m of history) {
    const past = !!m.runId && m.runId !== currentRunId;
    if (!past) {
      out.push(m);
      continue;
    }
    if (m.role === 'tool') {
      const content: ContentPart[] = m.content.map((p) =>
        p.type === 'tool_result' ? { ...p, output: digestResult(p) } : p,
      );
      out.push({ ...m, content });
      continue;
    }
    if (m.role === 'assistant') {
      const content = m.content.filter((p) => p.type !== 'reasoning');
      if (content.length === 0) continue;
      out.push({ ...m, content });
      continue;
    }
    out.push(m);
  }
  return out;
}
