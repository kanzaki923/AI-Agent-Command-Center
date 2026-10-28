import { getCurrentWindow } from '@tauri-apps/api/window';
import { useEffect, useState } from 'react';
import { isTauri } from '../../lib/platform';

// Segoe Fluent Icons (Win11) / MDL2 (Win10) glyphs.
const GLYPH = { min: '', max: '', restore: '', close: '' };

/** Windows-style caption buttons (46×40px, close hover #C42B1C). Tauri only. */
export function WindowControls() {
  const [maximized, setMaximized] = useState(false);

  // useEffect is required: subscribing to the native window's resize events (an external
  // system) to mirror the maximized state in the caption button.
  useEffect(() => {
    if (!isTauri()) return;
    const w = getCurrentWindow();
    let disposed = false;
    let unlisten: (() => void) | undefined;
    const sync = () =>
      void w.isMaximized().then((m) => {
        if (!disposed) setMaximized(m);
      });
    sync();
    void w
      .onResized(sync)
      .then((u) => {
        if (disposed) u();
        else unlisten = u;
      })
      .catch(() => {});
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  if (!isTauri()) return null;
  const w = getCurrentWindow();
  const base =
    'flex h-10 w-[46px] items-center justify-center text-fg-2 transition-colors duration-[80ms] hover:bg-hover active:bg-selected';
  return (
    <div className="flex h-10 shrink-0" role="group" aria-label="ウィンドウ操作">
      <button
        type="button"
        aria-label="最小化"
        className={base}
        style={{ font: '10px "Segoe Fluent Icons", "Segoe MDL2 Assets", sans-serif' }}
        onClick={() => void w.minimize()}
      >
        {GLYPH.min}
      </button>
      <button
        type="button"
        aria-label={maximized ? '元に戻す' : '最大化'}
        className={base}
        style={{ font: '10px "Segoe Fluent Icons", "Segoe MDL2 Assets", sans-serif' }}
        onClick={() => void w.toggleMaximize()}
      >
        {maximized ? GLYPH.restore : GLYPH.max}
      </button>
      <button
        type="button"
        aria-label="閉じる"
        className={`${base} hover:!bg-[#c42b1c] hover:!text-white`}
        style={{ font: '10px "Segoe Fluent Icons", "Segoe MDL2 Assets", sans-serif' }}
        onClick={() => void w.close()}
      >
        {GLYPH.close}
      </button>
    </div>
  );
}
