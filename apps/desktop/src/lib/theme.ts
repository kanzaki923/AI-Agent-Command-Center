import type { MotionPref, ThemePref } from '../store/ui';

export function resolveTheme(pref: ThemePref, systemDark: boolean): 'dark' | 'light' {
  if (pref === 'system') return systemDark ? 'dark' : 'light';
  return pref;
}

/** Glass is on only when the shell applied a window material AND the setting says so (ui-rework spec §1.3). */
export function resolveGlass(pref: 'on' | 'off', available: boolean): boolean {
  return available && pref === 'on';
}

/**
 * Mirror the theme / reduced-motion / glass preferences onto <html> (data-theme,
 * data-reduce-motion, data-glass). Runs outside React: it is a DOM + matchMedia sync, set up
 * once at startup. No transition on switch (ui-design §2.1). `glass` resolves whether the
 * window shows the desktop through (the Tauri shell says; the browser never does) and is
 * applied as soon as it answers.
 */
export function installThemeSync(
  read: () => { theme: ThemePref; reduceMotion: MotionPref; glass?: 'on' | 'off' },
  subscribe: (fn: () => void) => () => void,
  glass?: () => Promise<boolean>,
): () => void {
  const root = document.documentElement;
  const mq = typeof matchMedia === 'function' ? matchMedia('(prefers-color-scheme: dark)') : null;
  let glassAvailable = false;
  const apply = () => {
    const { theme, reduceMotion, glass: glassPref } = read();
    root.dataset.theme = resolveTheme(theme, mq?.matches ?? true);
    if (reduceMotion === 'system') delete root.dataset.reduceMotion;
    else root.dataset.reduceMotion = reduceMotion;
    if (resolveGlass(glassPref ?? 'on', glassAvailable)) root.dataset.glass = 'on';
    else delete root.dataset.glass;
  };
  apply();
  let disposed = false;
  glass?.()
    .then((ok) => {
      if (disposed) return;
      glassAvailable = ok;
      apply();
    })
    .catch(() => {});
  const unsub = subscribe(apply);
  mq?.addEventListener('change', apply);
  return () => {
    disposed = true;
    unsub();
    mq?.removeEventListener('change', apply);
  };
}

/** motion's MotionConfig value for the app setting. */
export function motionConfigValue(pref: MotionPref): 'user' | 'always' | 'never' {
  return pref === 'system' ? 'user' : pref === 'on' ? 'always' : 'never';
}
