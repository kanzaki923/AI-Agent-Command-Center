import { Minus, Plus } from 'lucide-react';
import type { ReactNode } from 'react';
import { cn } from '../../lib/cn';
import { Tooltip } from '../ui/Tooltip';

/**
 * Small controls shared by the settings, the 任せる / 繰り返す popovers and the cost popover
 * (track U5). Values are committed by the caller; nothing here talks to the daemon.
 */

export interface SegmentOption<T extends string> {
  value: T;
  /** Shown beside the icon; icon-only options carry it as their accessible name. */
  label: string;
  icon?: ReactNode;
  /** Hide the label (the icon says it); the label goes to the tooltip. */
  iconOnly?: boolean;
  /** One line, shown on hover. */
  hint?: string;
  disabled?: boolean;
}

/** A row of mutually exclusive choices (role radiogroup; ← → move the choice). */
export function Segmented<T extends string>({
  value,
  options,
  onChange,
  label,
  className,
}: {
  value: T | null;
  options: readonly SegmentOption<T>[];
  onChange: (v: T) => void;
  label: string;
  className?: string;
}) {
  const enabled = options.filter((o) => !o.disabled);
  return (
    <div
      role="radiogroup"
      aria-label={label}
      className={cn('inline-flex shrink-0 rounded-sm border border-line p-0.5 whitespace-nowrap', className)}
      onKeyDown={(e) => {
        if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
        e.preventDefault();
        const i = enabled.findIndex((o) => o.value === value);
        const next = enabled[(i + (e.key === 'ArrowRight' ? 1 : -1) + enabled.length) % enabled.length];
        if (!next) return;
        onChange(next.value);
        e.currentTarget.querySelector<HTMLElement>(`[data-value="${next.value}"]`)?.focus();
      }}
    >
      {options.map((o) => {
        const checked = o.value === value;
        const tip = o.iconOnly ? (o.hint ? `${o.label} · ${o.hint}` : o.label) : o.hint;
        return (
          <Tooltip key={o.value} content={tip ?? null}>
            <button
              type="button"
              role="radio"
              aria-checked={checked}
              aria-label={o.label}
              data-value={o.value}
              disabled={o.disabled}
              tabIndex={checked || (value === null && o === enabled[0]) ? 0 : -1}
              onClick={() => !checked && onChange(o.value)}
              className={cn(
                'inline-flex h-6 items-center gap-1.5 rounded-xs text-ui transition-colors duration-[120ms]',
                o.iconOnly ? 'w-7 justify-center' : 'px-2',
                checked ? 'bg-selected text-fg' : 'text-fg-3 hover:text-fg-2',
                'disabled:text-fg-4 disabled:hover:text-fg-4',
              )}
            >
              {o.icon}
              {!o.iconOnly && <span>{o.label}</span>}
            </button>
          </Tooltip>
        );
      })}
    </div>
  );
}

/**
 * An amount in USD typed by hand: '' → null (when `allowEmpty`), otherwise a positive amount
 * up to `max`, rounded to cents. `undefined` means "not a valid amount".
 */
export function parseUsd(
  text: string,
  opts: { max?: number; allowEmpty?: boolean; allowZero?: boolean } = {},
): number | null | undefined {
  const t = text.trim().replace(/^\$/, '').replace(/,/g, '');
  if (!t) return opts.allowEmpty ? null : undefined;
  const v = Number(t);
  if (!Number.isFinite(v) || v < 0 || (v === 0 && !opts.allowZero)) return undefined;
  if (opts.max != null && v > opts.max) return undefined;
  return Math.round(v * 100) / 100;
}

/** `$20` for whole dollars, `$2.50` otherwise. */
export function usdText(v: number): string {
  return Number.isInteger(v) ? String(v) : v.toFixed(2);
}

/**
 * An amount field with a `$` prefix. Committed on Enter or blur (Escape and invalid input
 * put the current value back); the field is keyed on `value`, so a change elsewhere shows.
 */
export function UsdField({
  value,
  onCommit,
  label,
  allowEmpty = false,
  allowZero = false,
  max = 10_000,
  placeholder,
  width = 88,
  id,
}: {
  value: number | null;
  onCommit: (v: number | null) => void;
  label: string;
  allowEmpty?: boolean;
  allowZero?: boolean;
  max?: number;
  placeholder?: string;
  width?: number;
  id?: string;
}) {
  const shown = value == null ? '' : usdText(value);
  const commit = (el: HTMLInputElement) => {
    const v = parseUsd(el.value, { max, allowEmpty, allowZero });
    if (v === undefined || v === value) {
      el.value = shown;
      return;
    }
    onCommit(v);
  };
  return (
    <span
      className="inline-flex h-7 items-center rounded-sm border border-line bg-canvas pl-2 transition-colors duration-[120ms] focus-within:border-[var(--focus-ring)] hover:border-line-strong"
      style={{ width }}
    >
      <span className="text-ui text-fg-3" aria-hidden="true">
        $
      </span>
      <input
        id={id}
        key={shown}
        aria-label={label}
        inputMode="decimal"
        defaultValue={shown}
        placeholder={placeholder}
        className="h-full w-full min-w-0 bg-transparent pr-2 pl-0.5 text-ui text-fg tabular outline-none placeholder:text-fg-4"
        onBlur={(e) => commit(e.currentTarget)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            commit(e.currentTarget);
          } else if (e.key === 'Escape' && e.currentTarget.value !== shown) {
            // First Escape puts the value back; the next one closes what holds the field.
            e.preventDefault();
            e.stopPropagation();
            e.currentTarget.value = shown;
          }
        }}
      />
    </span>
  );
}

/** − n + for small counts. */
export function Stepper({
  value,
  min,
  max,
  onChange,
  label,
}: {
  value: number;
  min: number;
  max: number;
  onChange: (v: number) => void;
  label: string;
}) {
  const btn = 'flex size-7 items-center justify-center text-fg-3 hover:bg-hover hover:text-fg disabled:text-fg-4 disabled:hover:bg-transparent';
  return (
    <span
      role="group"
      aria-label={label}
      className="inline-flex h-7 items-center overflow-hidden rounded-sm border border-line"
    >
      <button type="button" aria-label="減らす" className={btn} disabled={value <= min} onClick={() => onChange(value - 1)}>
        <Minus size={12} strokeWidth={2} />
      </button>
      <span className="w-7 text-center text-ui text-fg tabular" aria-live="polite">
        {value}
      </span>
      <button type="button" aria-label="増やす" className={btn} disabled={value >= max} onClick={() => onChange(value + 1)}>
        <Plus size={12} strokeWidth={2} />
      </button>
    </span>
  );
}

/** One labelled row of a settings-like form: the name on the left, the control on the right. */
export function FieldRow({
  label,
  hint,
  htmlFor,
  children,
  className,
}: {
  label: string;
  /** One line on hover over the name. */
  hint?: string;
  htmlFor?: string;
  children: ReactNode;
  className?: string;
}) {
  const name = (
    <label htmlFor={htmlFor} className="text-ui text-fg-2">
      {label}
    </label>
  );
  return (
    <div className={cn('flex min-h-8 items-center justify-between gap-4', className)}>
      {hint ? (
        <Tooltip content={hint} side="left">
          <span className="w-fit cursor-default">{name}</span>
        </Tooltip>
      ) : (
        name
      )}
      <div className="flex min-w-0 items-center gap-2">{children}</div>
    </div>
  );
}
