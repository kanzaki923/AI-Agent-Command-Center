import { randomBytes } from 'node:crypto';
import { ID_PREFIXES, type IdKind } from '@acc/protocol';
import type { Clock } from './clock';

// Lowercase Crockford base32 (no i, l, o, u).
const ALPHABET = '0123456789abcdefghjkmnpqrstvwxyz';

export interface IdGenerator {
  /** `<prefix>_<10 time chars><16 random chars>`; lexicographically sortable by creation. */
  next(kind: IdKind): string;
}

/**
 * ULID-style generator. Monotonic: within the same millisecond (or if the clock goes back)
 * the random part is incremented, so IDs from one generator always sort in creation order.
 */
export function createIdGenerator(clock: Clock): IdGenerator {
  let lastTime = -1;
  let lastRandom: number[] = [];

  function encodeTime(t: number): string {
    let out = '';
    for (let i = 0; i < 10; i++) {
      out = ALPHABET[t % 32]! + out;
      t = Math.floor(t / 32);
    }
    return out;
  }

  function freshRandom(): number[] {
    // Keep the top bit clear so increments within one ms never overflow in practice.
    const bytes = randomBytes(16);
    const r = Array.from(bytes, (b) => b % 32);
    r[0] = r[0]! % 16;
    return r;
  }

  function increment(r: number[]): number[] {
    const next = r.slice();
    for (let i = next.length - 1; i >= 0; i--) {
      if (next[i]! < 31) {
        next[i]!++;
        return next;
      }
      next[i] = 0;
    }
    throw new Error('ID random space exhausted within one millisecond');
  }

  return {
    next(kind) {
      const t = clock.now();
      if (t <= lastTime) {
        lastRandom = increment(lastRandom);
      } else {
        lastTime = t;
        lastRandom = freshRandom();
      }
      return `${ID_PREFIXES[kind]}_${encodeTime(lastTime)}${lastRandom.map((n) => ALPHABET[n]).join('')}`;
    },
  };
}
