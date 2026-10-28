import type { HumanActor, ServerMessage } from '@acc/protocol';

/**
 * A client connection (WebSocket). Handlers that need push (events.subscribe) use it;
 * in-process calls have `connection: null`.
 */
export interface Connection {
  readonly id: string;
  readonly actor: HumanActor;
  /** Send a server message; dropped silently if the socket is closed. */
  send(msg: ServerMessage): void;
  /** Subscriptions owned by this connection: id -> unsubscribe. Cleared on close. */
  readonly subscriptions: Map<string, () => void>;
  readonly closed: boolean;
}
