import { Check, Copy } from 'lucide-react';
import { useRef, useState } from 'react';
import { cn } from '../../lib/cn';
import { toast } from '../../store/toast';

/** Write text to the clipboard; false when the browser refuses (no permission, no API). */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (!navigator.clipboard) return false;
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

/**
 * Copy with a 1.2s "コピーしました" confirmation in place (no toast: the feedback is where the
 * pointer is). A refused clipboard says so, since silently doing nothing is the worst case.
 */
export function CopyButton({
  text,
  label = 'コピー',
  className,
  iconOnly = false,
}: {
  text: string | (() => string);
  label?: string;
  className?: string;
  iconOnly?: boolean;
}) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  return (
    <button
      type="button"
      aria-label={copied ? 'コピーしました' : label}
      title={iconOnly ? label : undefined}
      onClick={(e) => {
        e.stopPropagation();
        void copyText(typeof text === 'function' ? text() : text).then((ok) => {
          if (!ok) {
            toast({ title: 'コピーできませんでした', detail: 'クリップボードへのアクセスが許可されていません', tone: 'error', sticky: false });
            return;
          }
          setCopied(true);
          if (timer.current) clearTimeout(timer.current);
          timer.current = setTimeout(() => setCopied(false), 1200);
        });
      }}
      className={cn(
        'flex h-6 items-center gap-1 rounded-xs px-1.5 text-meta text-fg-3 hover:bg-hover hover:text-fg',
        copied && 'text-st-completed hover:text-st-completed',
        className,
      )}
    >
      {copied ? <Check size={12} strokeWidth={2} /> : <Copy size={12} strokeWidth={1.75} />}
      {!iconOnly && (copied ? 'コピーしました' : label)}
    </button>
  );
}
