import { type ButtonHTMLAttributes, type ReactNode, type Ref } from 'react';
import { cn } from '../../lib/cn';
import type { ShortcutId } from '../../lib/shortcuts';
import { Kbd } from './Kbd';
import { Tooltip } from './Tooltip';

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger';
type Size = 'sm' | 'md' | 'lg';

const VARIANT: Record<Variant, string> = {
  primary:
    'bg-accent text-accent-fg hover:bg-accent-hover disabled:bg-selected disabled:text-fg-4',
  secondary:
    'bg-surface text-fg border border-line hover:border-line-strong hover:bg-hover disabled:text-fg-4',
  ghost: 'text-fg-2 hover:bg-hover hover:text-fg disabled:text-fg-4',
  // High-risk approval: failed-colour outline (§5.2).
  danger:
    'bg-surface text-st-failed border border-[color-mix(in_oklch,var(--st-failed)_55%,transparent)] hover:bg-[color-mix(in_oklch,var(--st-failed)_10%,transparent)]',
};

const SIZE: Record<Size, string> = {
  sm: 'h-6 px-2 gap-1.5 text-meta',
  md: 'h-7 px-2.5 gap-2 text-ui',
  lg: 'h-8 px-3 gap-2 text-ui',
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  /** Shortcut shown on the button (principle 3: learnable shortcuts). */
  shortcut?: ShortcutId;
  shortcutKeys?: string;
  icon?: ReactNode;
  /** Tooltip; also explains why a button is disabled. */
  hint?: ReactNode;
  ref?: Ref<HTMLButtonElement>;
}

export function Button({
  variant = 'secondary',
  size = 'md',
  shortcut,
  shortcutKeys,
  icon,
  hint,
  className,
  children,
  ref,
  ...rest
}: ButtonProps) {
  const btn = (
    <button
      ref={ref}
      type="button"
      className={cn(
        'inline-flex shrink-0 items-center justify-center rounded-sm font-medium whitespace-nowrap select-none',
        'transition-colors duration-[120ms] hover:duration-0 disabled:pointer-events-none',
        VARIANT[variant],
        SIZE[size],
        className,
      )}
      {...rest}
    >
      {icon}
      {children}
      {(shortcut || shortcutKeys) && (
        <Kbd
          id={shortcut}
          keys={shortcutKeys}
          tone={variant === 'primary' ? 'onAccent' : 'default'}
          className="-mr-0.5"
        />
      )}
    </button>
  );
  if (!hint) return btn;
  // Disabled buttons do not fire pointer events; wrap so the tooltip still explains why.
  return (
    <Tooltip content={hint}>
      {rest.disabled ? <span className="inline-flex">{btn}</span> : btn}
    </Tooltip>
  );
}

/** Square icon-only button (24/28px hit target). */
export function IconButton({
  label,
  className,
  size = 'md',
  children,
  shortcut,
  ref,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  label: string;
  size?: 'sm' | 'md';
  shortcut?: ShortcutId;
  ref?: Ref<HTMLButtonElement>;
}) {
  return (
    <Tooltip
      content={
        <span className="inline-flex items-center gap-2">
          {label}
          {shortcut && <Kbd id={shortcut} />}
        </span>
      }
    >
      <button
        ref={ref}
        type="button"
        aria-label={label}
        className={cn(
          'inline-flex shrink-0 items-center justify-center rounded-sm text-fg-3 hover:bg-hover hover:text-fg disabled:text-fg-4',
          'transition-colors duration-[120ms] hover:duration-0',
          size === 'sm' ? 'size-6' : 'size-7',
          className,
        )}
        {...rest}
      >
        {children}
      </button>
    </Tooltip>
  );
}
