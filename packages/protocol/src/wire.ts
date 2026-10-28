import { z } from 'zod';
import { SubscriptionId } from './common';
import { Delta, Event } from './events';

/**
 * JSON-RPC-like wire protocol over WebSocket (`/ws?token=...`).
 *
 *   → { id, method, params }
 *   ← { id, result } | { id, error: { code, message, data? } }
 *   ← { type: "event", subscriptionId, event }   (after events.subscribe)
 *   ← { type: "delta", subscriptionId, delta }    (streaming fragments, not persisted)
 */

export const ERROR_CODES = [
  'invalid_params',
  'not_found',
  'forbidden', // capability violation
  'budget_exceeded',
  'conflict', // locks, invalid state transitions
  'limit_exceeded', // concurrency / delegation depth
  'internal',
] as const;
export const ErrorCode = z.enum(ERROR_CODES);
export type ErrorCode = z.infer<typeof ErrorCode>;

/** Client-side only codes (never sent by the daemon). */
export const CLIENT_ERROR_CODES = ['connection_lost', 'timeout', 'closed'] as const;
export type ClientErrorCode = (typeof CLIENT_ERROR_CODES)[number];

export const RpcError = z.object({
  code: ErrorCode,
  message: z.string(),
  data: z.unknown().optional(),
});
export type RpcError = z.infer<typeof RpcError>;

export const RequestId = z.union([z.int(), z.string()]);
export type RequestId = z.infer<typeof RequestId>;

export const RpcRequest = z.object({
  id: RequestId,
  method: z.string(),
  params: z.unknown().optional(),
});
export type RpcRequest = z.infer<typeof RpcRequest>;

export type RpcSuccess = { id: RequestId; result: unknown };
export type RpcFailure = { id: RequestId | null; error: RpcError };
export type RpcResponse = RpcSuccess | RpcFailure;

export type EventPush = { type: 'event'; subscriptionId: string; event: Event };
export type DeltaPush = { type: 'delta'; subscriptionId: string; delta: Delta };
export type ServerPush = EventPush | DeltaPush;

export type ServerMessage = RpcResponse | ServerPush;

export const EventPushSchema = z.object({
  type: z.literal('event'),
  subscriptionId: SubscriptionId,
  event: Event,
});
export const DeltaPushSchema = z.object({
  type: z.literal('delta'),
  subscriptionId: SubscriptionId,
  delta: Delta,
});

export function isPush(msg: ServerMessage): msg is ServerPush {
  return 'type' in msg && (msg.type === 'event' || msg.type === 'delta');
}

export function isFailure(msg: RpcResponse): msg is RpcFailure {
  return 'error' in msg;
}

/** WebSocket path and HTTP health path. */
export const WS_PATH = '/ws';
export const HEALTH_PATH = '/health';
export const DEFAULT_PORT = 47821;
export const PROTOCOL_VERSION = 1;
