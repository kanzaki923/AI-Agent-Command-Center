import type { StreamingMessage } from '@acc/protocol';
import type { StreamsService } from '../contracts';
import type { DaemonContext } from '../core/context';

/** Text kept per stream; later fragments are dropped (the final message has everything). */
export const MAX_STREAM_CHARS = 1_000_000;

interface Stream {
  runId: string;
  sessionId: string;
  messageId: string;
  text: string;
  reasoning: string;
  /** Kind of the latest fragment (the chip shows 考え中 / 回答を作成中 from it). */
  lastKind: 'text' | 'reasoning' | null;
}

/**
 * Text being streamed right now, per run (architecture.md §2.19). The run manager hands
 * every delta here (`RunController.emitDelta`), so a client that opens a chat mid-answer
 * gets what was already written (`session.messages` `streaming`) instead of a blank turn.
 * In memory only: a restart interrupts the run, and its partial text is persisted by then.
 * A stream ends when the run persists an assistant message or ends.
 */
export class LiveStreams implements StreamsService {
  private readonly byRun = new Map<string, Stream>();

  constructor(
    private readonly ctx: DaemonContext,
    /** Called when a stream starts writing a new kind of fragment (for "what is it doing"). */
    private readonly onKind: (sessionId: string, kind: 'text' | 'reasoning') => void = () => {},
  ) {}

  append(runId: string, messageId: string, kind: 'text' | 'reasoning', text: string): void {
    if (!text) return;
    let s = this.byRun.get(runId);
    if (!s || s.messageId !== messageId) {
      const sessionId = s?.sessionId ?? this.ctx.repos.runs.get(runId)?.sessionId;
      if (!sessionId) return;
      s = { runId, sessionId, messageId, text: '', reasoning: '', lastKind: null };
      this.byRun.set(runId, s);
    }
    if (kind === 'text') {
      if (s.text.length < MAX_STREAM_CHARS) s.text += text;
    } else if (s.reasoning.length < MAX_STREAM_CHARS) {
      s.reasoning += text;
    }
    if (s.lastKind !== kind) {
      s.lastKind = kind;
      this.onKind(s.sessionId, kind);
    }
  }

  snapshot(sessionId: string): StreamingMessage | null {
    for (const s of this.byRun.values()) {
      if (s.sessionId !== sessionId) continue;
      return { messageId: s.messageId, runId: s.runId, text: s.text, reasoning: s.reasoning };
    }
    return null;
  }

  /** The run persisted an assistant message: what was streamed is in it now. */
  messagePersisted(runId: string): void {
    this.byRun.delete(runId);
  }

  /** The run ended (its partial text, if any, was persisted on the way out). */
  runEnded(runId: string): void {
    this.byRun.delete(runId);
  }

  /** Number of live streams (tests). */
  get size(): number {
    return this.byRun.size;
  }
}
