import { describe, expect, it } from 'vitest';
import { createManualClock } from '../core/clock';
import { KeyedThrottle } from './throttle';

describe('KeyedThrottle', () => {
  it('emits the first change at once and folds the rest of the second into one trailing call', async () => {
    const clock = createManualClock();
    const t = new KeyedThrottle(clock, 1000);
    const out: string[] = [];
    let latest = 0;
    const touch = (key: string) => {
      latest += 1;
      const v = latest;
      t.touch(
        key,
        () => out.push(`${key}:now:${v}`),
        () => out.push(`${key}:later:${latest}`),
      );
    };
    touch('a');
    touch('a');
    touch('a');
    touch('b');
    expect(out).toEqual(['a:now:1', 'b:now:4']);
    // A quiet key after the interval emits at once again (no trailing pending for b).
    clock.advance(1000);
    touch('b');
    expect(out).toEqual(['a:now:1', 'b:now:4', 'b:now:5']);
    t.flush();
    expect(out).toEqual(['a:now:1', 'b:now:4', 'b:now:5', 'a:later:5']);
    t.close();
  });

  it('fires the trailing call by itself after the interval', async () => {
    const t = new KeyedThrottle(createManualClock(), 20);
    const out: string[] = [];
    t.touch(
      'k',
      () => out.push('now'),
      () => out.push('never'),
    );
    t.touch(
      'k',
      () => out.push('no'),
      () => out.push('later'),
    );
    await new Promise((r) => setTimeout(r, 60));
    expect(out).toEqual(['now', 'later']);
    t.close();
  });
});
