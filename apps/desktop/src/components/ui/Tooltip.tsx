import { Tooltip as T } from 'radix-ui';
import type { ReactNode } from 'react';

export function TooltipProvider({ children }: { children: ReactNode }) {
  return (
    <T.Provider delayDuration={500} skipDelayDuration={300}>
      {children}
    </T.Provider>
  );
}

/** Small hint bubble (level 2, z-tooltip 80). `content` null renders the child as-is. */
export function Tooltip({
  content,
  children,
  side = 'top',
}: {
  content: ReactNode;
  children: ReactNode;
  side?: 'top' | 'bottom' | 'left' | 'right';
}) {
  if (content == null || content === '') return <>{children}</>;
  return (
    <T.Root>
      <T.Trigger asChild>{children}</T.Trigger>
      <T.Portal>
        <T.Content
          side={side}
          sideOffset={6}
          className="z-[80] max-w-80 rounded-sm border border-line bg-raised px-2 py-1 text-meta text-fg-2 shadow-float"
        >
          {content}
        </T.Content>
      </T.Portal>
    </T.Root>
  );
}
