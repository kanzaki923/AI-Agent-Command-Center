import type { MotionPref, ThemePref } from '../store/ui';

export function resolveTheme(pref: ThemePref, systemDark: boolean): 'dark' | 'light' {
  if (pref === 'system') return systemDark ? 'dark' : 'light';
  return pref;
}

/**
 * Mirror the theme / reduced-motion preferences onto <html> (data-theme,
 * data-reduce-motion). Runs outside React: it is a DOM + matchMedia sync, set up once at
 * startup. No transition on switch (ui-design §2.1).
 */
export function installThemeSync(
  read: () => { theme: ThemePref; reduceMotion: MotionPref },
  subscribe: (fn: () => void) => () => void,
): () => void {
  const root = document.documentElement;
  const mq = typeof matchMedia === 'function' ? matchMedia('(prefers-color-scheme: dark)') : null;
  const apply = () => {
    const { theme, reduceMotion } = read();
    root.dataset.theme = resolveTheme(theme, mq?.matches ?? true);
    if (reduceMotion === 'system') delete root.dataset.reduceMotion;
    else root.dataset.reduceMotion = reduceMotion;
  };
  apply();
  const unsub = subscribe(apply);
  mq?.addEventListener('change', apply);
  return () => {
    unsub();
    mq?.removeEventListener('change', apply);
  };
}

/** motion's MotionConfig value for the app setting. */
export function motionConfigValue(pref: MotionPref): 'user' | 'always' | 'never' {
  return pref === 'system' ? 'user' : pref === 'on' ? 'always' : 'never';
}
