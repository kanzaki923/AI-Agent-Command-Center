import { X } from 'lucide-react';
import { Dialog as D } from 'radix-ui';
import type { ReactNode } from 'react';
import { cn } from '../../lib/cn';

/** Modal dialog (level 3, z-dialog 60): scale 0.98 → 1 + fade, 140ms (§3.2). */
export function Dialog({
  open,
  onOpenChange,
  title,
  description,
  children,
  className,
  footer,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  children: ReactNode;
  className?: string;
  footer?: ReactNode;
}) {
  return (
    <D.Root open={open} onOpenChange={onOpenChange}>
      <D.Portal>
        <D.Overlay className="fixed inset-0 z-[60] bg-overlay data-[state=open]:animate-[acc-fade-in_140ms_var(--ease-out)]" />
        <D.Content
          className={cn(
            'fixed top-1/2 left-1/2 z-[60] flex max-h-[85vh] w-[560px] max-w-[calc(100vw-32px)] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-lg border border-line-strong bg-raised shadow-modal outline-none',
            'data-[state=open]:animate-[acc-dialog-in_140ms_var(--ease-out)]',
            className,
          )}
        >
          <div className="flex items-start gap-3 px-5 pt-4 pb-3">
            <div className="min-w-0 flex-1">
              <D.Title className="text-title text-fg">{title}</D.Title>
              {description ? (
                <D.Description className="mt-0.5 text-ui text-fg-3">{description}</D.Description>
              ) : (
                <D.Description className="sr-only">{title}</D.Description>
              )}
            </div>
            <D.Close
              aria-label="閉じる"
              className="flex size-7 items-center justify-center rounded-sm text-fg-3 hover:bg-hover hover:text-fg"
            >
              <X size={15} strokeWidth={1.5} />
            </D.Close>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-5">{children}</div>
          {footer && <div className="flex justify-end gap-2 border-t border-line-subtle px-5 py-3">{footer}</div>}
        </D.Content>
      </D.Portal>
    </D.Root>
  );
}

export function FieldLabel({ children, htmlFor }: { children: ReactNode; htmlFor?: string }) {
  return (
    <label htmlFor={htmlFor} className="mb-1 block text-meta font-medium text-fg-2">
      {children}
    </label>
  );
}

export const inputClass =
  'h-8 w-full rounded-sm border border-line bg-canvas px-2.5 text-ui text-fg placeholder:text-fg-4 transition-colors duration-[120ms] hover:border-line-strong focus:border-[var(--focus-ring)] disabled:text-fg-4';
