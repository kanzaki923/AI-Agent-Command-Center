import { AnimatePresence, motion } from 'motion/react';
import { useStore } from 'zustand';
import { useConnectionState, useRuntime } from '../../daemon/runtime';
import { useNow } from '../../hooks/useNow';

/**
 * 32px band at the top of the main area while the daemon connection is down (§8.4).
 * Disappears in 120ms once reconnected.
 */
export function ReconnectBanner() {
  const rt = useRuntime();
  const state = useConnectionState();
  const everConnected = useStore(rt.status, (s) => s.everConnected);
  const show = everConnected && (state === 'reconnecting' || state === 'connecting');
  return (
    <AnimatePresence initial={false}>
      {show && (
        <motion.div
          role="status"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0, transition: { duration: 0.12 } }}
          className="flex h-8 shrink-0 items-center gap-2 border-b px-4 text-ui"
          style={{
            background: 'color-mix(in oklch, var(--st-awaiting_approval) 10%, var(--bg-canvas))',
            borderColor: 'color-mix(in oklch, var(--st-awaiting_approval) 25%, transparent)',
          }}
        >
          <span className="size-1.5 animate-pulse rounded-full bg-st-awaiting_approval" />
          <span className="text-fg">Core Daemon に再接続しています…</span>
          <span className="text-fg-3">エージェントはバックグラウンドで動き続けています</span>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

/**
 * The only full-screen wait (§8.3): the very first daemon connection. App mark only;
 * a status line after 1s; the concrete reason after 3s.
 */
export function StartupScreen({ startedAt }: { startedAt: number }) {
  const rt = useRuntime();
  const now = useNow();
  const lastError = useStore(rt.status, (s) => s.lastError);
  const waited = now - startedAt;
  return (
    <div className="flex h-full flex-col items-center justify-center gap-4 bg-app" data-tauri-drag-region>
      <AppMark />
      <div className="h-10 text-center">
        {waited >= 1000 && <div className="text-ui text-fg-3">デーモンの起動を待っています…</div>}
        {waited >= 3000 && lastError && <div className="mt-1 max-w-[520px] text-meta text-fg-3">{lastError}</div>}
      </div>
    </div>
  );
}

export function AppMark({ size = 40 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 40 40" aria-label="AI Agent Command Center" role="img">
      <rect x="1" y="1" width="38" height="38" rx="10" fill="var(--bg-surface)" stroke="var(--border-strong)" />
      <circle cx="20" cy="20" r="3.4" fill="var(--accent)" />
      {[0, 60, 120, 180, 240, 300].map((deg) => {
        const r = (deg * Math.PI) / 180;
        return (
          <circle
            key={deg}
            cx={20 + Math.cos(r) * 10.5}
            cy={20 + Math.sin(r) * 10.5}
            r="2"
            fill="var(--text-secondary)"
            opacity={deg === 0 ? 1 : 0.55}
          />
        );
      })}
    </svg>
  );
}
