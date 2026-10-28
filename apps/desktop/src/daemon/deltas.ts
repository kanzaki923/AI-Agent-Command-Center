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

export function streamingForSession(state: DeltaState, sessionId: string): StreamingMessage[] {
  return Object.values(state.byMessage)
    .filter((m) => m.sessionId === sessionId)
    .sort((a, b) => a.startedAt - b.startedAt);
}
