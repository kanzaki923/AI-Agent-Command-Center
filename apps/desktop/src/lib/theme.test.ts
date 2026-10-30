import { afterEach, describe, expect, it } from 'vitest';
import { installThemeSync, resolveGlass, resolveTheme } from './theme';

const root = () => document.documentElement;
const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const fn of cleanups.splice(0)) fn();
  for (const k of ['theme', 'reduceMotion', 'glass', 'glassScope', 'glassStrength']) {
    delete root().dataset[k];
  }
});

describe('theme sync', () => {
  it('resolves the theme and whether glass shows', () => {
    expect(resolveTheme('system', true)).toBe('dark');
    expect(resolveTheme('light', true)).toBe('light');
    expect(resolveGlass('on', false)).toBe(false);
    expect(resolveGlass('off', true)).toBe(false);
    expect(resolveGlass('on', true)).toBe(true);
  });

  it('puts the glass scope and strength on <html> once the shell says the window has a material', async () => {
    let state = {
      theme: 'dark' as const,
      reduceMotion: 'system' as const,
      glass: 'on' as 'on' | 'off',
      glassScope: 'all' as const,
      glassStrength: 'strong' as const,
    };
    const listeners = new Set<() => void>();
    cleanups.push(
      installThemeSync(
        () => state,
        (fn) => {
          listeners.add(fn);
          return () => listeners.delete(fn);
        },
        () => Promise.resolve(true),
      ),
    );
    // Before the shell answers: no glass, whatever the setting.
    expect(root().dataset.glass).toBeUndefined();
    await Promise.resolve();
    await Promise.resolve();
    expect(root().dataset).toMatchObject({
      theme: 'dark',
      glass: 'on',
      glassScope: 'all',
      glassStrength: 'strong',
    });

    state = { ...state, glass: 'off' };
    for (const fn of listeners) fn();
    expect(root().dataset.glass).toBeUndefined();
    expect(root().dataset.glassScope).toBeUndefined();
    expect(root().dataset.glassStrength).toBeUndefined();
  });

  it('never shows glass in the browser (the shell answers false)', async () => {
    cleanups.push(
      installThemeSync(
        () => ({
          theme: 'light',
          reduceMotion: 'on',
          glass: 'on',
          glassScope: 'wings',
          glassStrength: 'mid',
        }),
        () => () => {},
        () => Promise.resolve(false),
      ),
    );
    await Promise.resolve();
    await Promise.resolve();
    expect(root().dataset).toMatchObject({ theme: 'light', reduceMotion: 'on' });
    expect(root().dataset.glass).toBeUndefined();
  });
});
