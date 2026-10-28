import { cn } from '../../lib/cn';
import { SHORTCUTS, type ShortcutId, keyParts } from '../../lib/shortcuts';

/** Shortcut label (ui-design §11). Pass `id` to read from shortcuts.ts, or raw `keys`. */
export function Kbd({
  id,
  keys,
  className,
  tone = 'default',
}: {
  id?: ShortcutId;
  keys?: string;
  className?: string;
  tone?: 'default' | 'onAccent';
}) {
  const k = keys ?? (id ? SHORTCUTS[id].keys : '');
  return (
    <span className={cn('inline-flex items-center gap-0.5', className)} aria-hidden="true">
      {keyParts(k).map((p, i) => (
        <kbd
          key={i}
          className={cn(
            'inline-flex h-4 min-w-4 items-center justify-center rounded-xs px-1 font-sans text-[10.5px] leading-none font-medium tabular',
            tone === 'onAccent' ? 'bg-white/18 text-accent-fg' : 'bg-selected text-fg-3',
          )}
        >
          {p}
        </kbd>
      ))}
    </span>
  );
}
