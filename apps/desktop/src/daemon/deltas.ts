import type { Delta } from '@acc/protocol';
import { createStore } from 'zustand/vanilla';

export interface StreamingMessage {
  messageId: string;
  sessionId: string;
  runId: string;
  text: string;
  reasoning: string;
  lastIndex: number;
  startedAt: number;
  /** Joined mid-stream (first delta index > 0): earlier text was never received. */
  partial: boolean;
}

interface DeltaState {
  byMessage: Record<string, StreamingMessage>;
}

type Schedule = (cb: () => void) => void;

const defaultSchedule: Schedule = (cb) => {
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => cb());
  else setTimeout(cb, 16);
};

/**
 * Streaming text of in-progress assistant messages. Deltas are buffered and applied once
 * per animation frame (ui-design §6.1: ten parallel streams still render once per frame).
 * A message leaves the store when its persisted `message.created` arrives or its run ends.
 */
export function createDeltaStore(schedule: Schedule = defaultSchedule) {
  const store = createStore<DeltaState>(() => ({ byMessage: {} }));
  let buffer: Delta[] = [];
  let scheduled = false;

  const flush = () => {
    scheduled = false;
    if (buffer.length === 0) return;
    const pending = buffer;
    buffer = [];
    const next = { ...store.getState().byMessage };
    for (const d of pending) {
      const cur = next[d.messageId];
      // Drop duplicates / out-of-order replays (index is per message).
      if (cur && d.index <= cur.lastIndex) continue;
      const base: StreamingMessage = cur ?? {
        messageId: d.messageId,
        sessionId: d.sessionId,
        runId: d.runId,
        text: '',
        reasoning: '',
        lastIndex: -1,
        startedAt: Date.now(),
        partial: d.index > 0,
      };
      next[d.messageId] = {
        ...base,
        text: d.kind === 'text' ? base.text + d.text : base.text,
        reasoning: d.kind === 'reasoning' ? base.reasoning + d.text : base.reasoning,
        lastIndex: d.index,
      };
    }
    store.setState({ byMessage: next });
  };

  return {
    store,
    push(delta: Delta) {
      buffer.push(delta);
      if (!scheduled) {
        scheduled = true;
        schedule(flush);
      }
    },
    /** Apply buffered deltas now (tests, and before removing a finished message). */
    flush,
    /**
     * What the daemon says was already written (`session.messages` `streaming`), for a chat
     * opened mid-answer. Deltas received before the snapshot overlap its end; the merge keeps
     * every character once. A stream already followed from its first delta is left alone.
     */
    seed(sessionId: string, snap: { messageId: string; runId: string; text: string; reasoning: string }) {
      flush();
      const cur = store.getState().byMessage[snap.messageId];
      if (cur && !cur.partial) return;
      const next: StreamingMessage = cur
        ? {
            ...cur,
            text: mergeOverlap(snap.text, cur.text),
            reasoning: mergeOverlap(snap.reasoning, cur.reasoning),
            partial: false,
          }
        : {
            messageId: snap.messageId,
            sessionId,
            runId: snap.runId,
            text: snap.text,
            reasoning: snap.reasoning,
            // Deltas continue from the snapshot; their index is unknown, so accept any.
            lastIndex: -1,
            startedAt: Date.now(),
            partial: false,
          };
      store.setState({ byMessage: { ...store.getState().byMessage, [snap.messageId]: next } });
    },
    finishMessage(messageId: string) {
      flush();
      const cur = store.getState().byMessage;
      if (!(messageId in cur)) return;
      const next = { ...cur };
      delete next[messageId];
      store.setState({ byMessage: next });
    },
    finishRun(runId: string) {
      flush();
      const cur = store.getState().byMessage;
      const ids = Object.values(cur)
        .filter((m) => m.runId === runId)
        .map((m) => m.messageId);
      if (ids.length === 0) return;
      const next = { ...cur };
      for (const id of ids) delete next[id];
      store.setState({ byMessage: next });
    },
  };
}

export type DeltaStore = ReturnType<typeof createDeltaStore>;

/**
 * `head` (everything up to some point) joined with `tail` (received from some later-or-earlier
 * point on): the longest end of `head` that starts `tail` is counted once.
 */
export function mergeOverlap(head: string, tail: string): string {
  if (!tail) return head;
  if (!head) return tail;
  const max = Math.min(head.length, tail.length, 20_000);
  // A short match ("。") is more likely chance than overlap: below 6 characters only a
  // tail that is wholly inside the head counts.
  const min = Math.min(6, tail.length);
  for (let k = max; k >= min && k > 0; k--) {
    if (head.endsWith(tail.slice(0, k))) return head + tail.slice(k);
  }
  return head + tail;
}

export function streamingForSession(state: DeltaState, sessionId: string): StreamingMessage[] {
  return Object.values(state.byMessage)
    .filter((m) => m.sessionId === sessionId)
    .sort((a, b) => a.startedAt - b.startedAt);
}
