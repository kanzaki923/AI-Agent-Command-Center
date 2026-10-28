import { DropdownMenu, Popover as P } from 'radix-ui';
import type { ReactNode } from 'react';
import { cn } from '../../lib/cn';
import type { ShortcutId } from '../../lib/shortcuts';
import { Kbd } from './Kbd';

const LAYER =
  'z-[40] rounded-md border border-line bg-raised p-1 shadow-float outline-none origin-[var(--radix-popper-transform-origin)] data-[state=open]:animate-[acc-pop-in_180ms_var(--ease-out)]';

export const Menu = DropdownMenu.Root;
export const MenuTrigger = DropdownMenu.Trigger;

export function MenuContent({
  children,
  align = 'start',
  className,
}: {
  children: ReactNode;
  align?: 'start' | 'end' | 'center';
  className?: string;
}) {
  return (
    <DropdownMenu.Portal>
      <DropdownMenu.Content align={align} sideOffset={6} className={cn(LAYER, 'min-w-52', className)}>
        {children}
      </DropdownMenu.Content>
    </DropdownMenu.Portal>
  );
}

export function MenuItem({
  children,
  icon,
  shortcut,
  onSelect,
  danger,
  checked,
  disabled,
}: {
  children: ReactNode;
  icon?: ReactNode;
  shortcut?: ShortcutId;
  onSelect?: () => void;
  danger?: boolean;
  checked?: boolean;
  disabled?: boolean;
}) {
  return (
    <DropdownMenu.Item
      disabled={disabled}
      onSelect={onSelect}
      className={cn(
        'flex min-h-7 items-center gap-2 rounded-sm px-2 text-ui outline-none select-none data-[disabled]:text-fg-4',
        'data-[highlighted]:bg-selected',
        danger ? 'text-st-failed' : 'text-fg',
      )}
    >
      <span className="flex w-4 justify-center text-fg-3">{icon}</span>
      <span className="flex-1 truncate">{children}</span>
      {checked && <span className="text-accent">●</span>}
      {shortcut && <Kbd id={shortcut} />}
    </DropdownMenu.Item>
  );
}

export function MenuLabel({ children }: { children: ReactNode }) {
  return (
    <DropdownMenu.Label className="px-2 pt-1.5 pb-1 text-micro text-fg-3">{children}</DropdownMenu.Label>
  );
}

export function MenuSeparator() {
  return <DropdownMenu.Separator className="my-1 h-px bg-line-subtle" />;
}

export const Popover = P.Root;
export const PopoverTrigger = P.Trigger;
export const PopoverAnchor = P.Anchor;

export function PopoverContent({
  children,
  className,
  align = 'start',
  side = 'bottom',
}: {
  children: ReactNode;
  className?: string;
  align?: 'start' | 'end' | 'center';
  side?: 'top' | 'bottom';
}) {
  return (
    <P.Portal>
      <P.Content
        align={align}
        side={side}
        sideOffset={6}
        className={cn(LAYER, 'p-0', className)}
        onOpenAutoFocus={(e) => {
          // cmdk inputs inside take focus themselves.
          const input = (e.currentTarget as HTMLElement | null)?.querySelector('input');
          if (input) {
            e.preventDefault();
            input.focus();
          }
        }}
      >
        {children}
      </P.Content>
    </P.Portal>
  );
}
