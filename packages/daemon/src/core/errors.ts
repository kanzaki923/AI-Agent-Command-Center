import type { ErrorCode, RpcError } from '@acc/protocol';

/**
 * The only error type that crosses the API boundary with its code intact. Anything else
 * thrown by a handler becomes `internal`.
 */
export class ApiError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly data?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }

  toRpc(): RpcError {
    return this.data === undefined
      ? { code: this.code, message: this.message }
      : { code: this.code, message: this.message, data: this.data };
  }
}

export const notFound = (kind: string, id: string) =>
  new ApiError('not_found', `${kind} not found: ${id}`, { kind, id });

export const invalidParams = (message: string, data?: unknown) =>
  new ApiError('invalid_params', message, data);

export const conflict = (message: string, data?: unknown) =>
  new ApiError('conflict', message, data);

export const forbidden = (message: string, data?: unknown) =>
  new ApiError('forbidden', message, data);

export const limitExceeded = (message: string, data?: unknown) =>
  new ApiError('limit_exceeded', message, data);

export const budgetExceeded = (message: string, data?: unknown) =>
  new ApiError('budget_exceeded', message, data);

export function isApiError(err: unknown): err is ApiError {
  return err instanceof ApiError;
}
