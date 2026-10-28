import { CheckCircle2, Info, TriangleAlert, X } from 'lucide-react';
import { cn } from '../../lib/cn';
import { useToasts } from '../../store/toast';

const MAX_VISIBLE = 3;

/** Bottom-right, 360px, max 3 stacked; older ones fold into "ほか N 件" (§8.5). */
export function Toaster() {
  const toasts = useToasts((s) => s.toasts);
  const dismiss = useToasts((s) => s.dismiss);
  const pause = useToasts((s) => s.pause);
  const resume = useToasts((s) => s.resume);
  const visible = toasts.slice(-MAX_VISIBLE);
  const hidden = toasts.length - visible.length;
  return (
    <div className="pointer-events-none fixed right-4 bottom-4 z-[50] flex w-[360px] flex-col gap-2" aria-live="polite">
      {hidden > 0 && (
        <button
          type="button"
          onClick={() => toasts.slice(0, hidden).forEach((t) => dismiss(t.id))}
          className="pointer-events-auto self-end rounded-full border border-line bg-raised px-2.5 py-0.5 text-meta text-fg-3 shadow-float hover:text-fg"
        >
          ほか {hidden} 件
        </button>
      )}
      {visible.map((t) => (
        <div
          key={t.id}
          role={t.tone === 'error' ? 'alert' : 'status'}
          onMouseEnter={() => pause(t.id)}
          onMouseLeave={() => resume(t.id)}
          className="pointer-events-auto flex items-start gap-2.5 rounded-md border border-line bg-raised px-3 py-2.5 shadow-float"
          style={{ animation: 'acc-toast-in 180ms var(--ease-out)' }}
        >
          <span
            className={cn(
              'mt-0.5 shrink-0',
              t.tone === 'error' ? 'text-st-failed' : t.tone === 'success' ? 'text-st-completed' : 'text-fg-3',
            )}
          >
            {t.tone === 'error' ? (
              <TriangleAlert size={15} strokeWidth={1.75} />
            ) : t.tone === 'success' ? (
              <CheckCircle2 size={15} strokeWidth={1.75} />
            ) : (
              <Info size={15} strokeWidth={1.75} />
            )}
          </span>
          <div className="min-w-0 flex-1">
            <div className="text-ui text-fg">{t.title}</div>
            {t.detail && (t.tone !== 'error' || t.showDetail) && <div className="mt-0.5 text-meta text-fg-3">{t.detail}</div>}
            {t.action && (
              <button
                type="button"
                onClick={() => {
                  t.action!.run();
                  dismiss(t.id);
                }}
                className="mt-1 text-ui font-medium text-accent hover:underline"
              >
                {t.action.label}
              </button>
            )}
          </div>
          <button
            type="button"
            aria-label="閉じる"
            onClick={() => dismiss(t.id)}
            className="flex size-5 shrink-0 items-center justify-center rounded-xs text-fg-4 hover:text-fg-2"
          >
            <X size={13} />
          </button>
        </div>
      ))}
    </div>
  );
}
