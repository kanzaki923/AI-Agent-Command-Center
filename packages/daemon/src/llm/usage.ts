import type { Usage } from '@acc/protocol';

/** The prompt cache counts of a call, only those that are not zero (a Usage spread). */
export function cacheCounts(read: number, write = 0): Pick<Usage, 'cacheReadTokens' | 'cacheWriteTokens'> {
  return {
    ...(read > 0 ? { cacheReadTokens: Math.round(read) } : {}),
    ...(write > 0 ? { cacheWriteTokens: Math.round(write) } : {}),
  };
}
