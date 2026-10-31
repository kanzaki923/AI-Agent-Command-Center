import type { ModelInfo, ModelRule, SettingsView } from '@acc/protocol';
import { Command } from 'cmdk';
import { Check, ChevronDown, GripVertical, Lock, Plus, X } from 'lucide-react';
import { useState } from 'react';
import { useModels } from '../../daemon/queries';
import { cn } from '../../lib/cn';
import { PRICE_UNIT, priceParts, priceText, shortModel } from '../../lib/models';
import { Popover, PopoverContent, PopoverTrigger } from '../ui/Menu';
import { Tooltip } from '../ui/Tooltip';

/**
 * The model roster (snapshot 20261030_model-roster-spec.md): rows read top to bottom, the
 * first whose "when" fits a piece of work gives its model; the last row ("それ以外") is
 * `defaultModel`, where the person's own conversations start too. Each row shows the list
 * price per 1M tokens, so cost stays in view while choosing (what was spent: 利用統計).
 *
 * The row is quiet so the list reads as a list: the model is a chip on a face, the "when"
 * is plain text until pointed at, the price is input and output as right-aligned columns with two decimals (the points line up), and
 * the remove button shows on hover.
 */

export type RosterPatch = { modelRules: ModelRule[] } | { defaultModel: string };

/** `gpt-6.1-sol ほか 2`: the summary line of the settings row. */
export function rosterSummary(settings: SettingsView | undefined): string {
  if (!settings) return '';
  const base = settings?.defaultModel;
  const n = settings?.modelRules?.length ?? 0;
  if (!base) return n > 0 ? `${n} 行` : '最初の会話で決まります';
  return n > 0 ? `${shortModel(base) || base} ほか ${n}` : shortModel(base) || base;
}

/** Move one item of a list from `from` to `to`. */
export function moveItem<T>(list: readonly T[], from: number, to: number): T[] {
  const next = [...list];
  const [item] = next.splice(from, 1);
  if (item === undefined) return next;
  next.splice(Math.max(0, Math.min(to, next.length)), 0, item);
  return next;
}

/** grip · number · model · when · price (input, output) · remove */
const COLS = 'grid grid-cols-[14px_14px_minmax(0,150px)_minmax(0,1fr)_112px_16px] items-center gap-2';

export function ModelRosterPanel({
  settings,
  onSave,
}: {
  settings: SettingsView | undefined;
  onSave: (patch: RosterPatch) => void;
}) {
  const models = useModels().data?.models ?? [];
  const rules = settings?.modelRules ?? [];
  const base = settings?.defaultModel ?? null;
  const [dragging, setDragging] = useState<number | null>(null);
  const [over, setOver] = useState<number | null>(null);
  const info = (id: string) => models.find((m) => m.id === id);
  const save = (next: ModelRule[]) => onSave({ modelRules: next });
  const move = (from: number, to: number) => {
    if (from !== to) save(moveItem(rules, from, to));
  };
  const usable = models.filter((m) => !m.id.startsWith('mock/'));
  const addable = usable.find((m) => m.id !== base && !rules.some((r) => r.model === m.id)) ?? usable[0];

  return (
    <div data-testid="model-roster" className="flex flex-col">
      <div className={cn(COLS, 'pb-1 text-micro text-fg-3')} aria-hidden>
        <span />
        <span />
        <span>モデル</span>
        <span className="px-2">こういうとき</span>
        <Tooltip content={PRICE_UNIT}>
          <span className={cn(PRICE_COLS, 'cursor-default')}>
            <span>入力</span>
            <span>出力</span>
          </span>
        </Tooltip>
        <span />
      </div>
      <ol className="flex flex-col" aria-label="使うモデル（上から順に、最初に当てはまったもの）">
        {rules.map((r, i) => (
          <li
            key={`${i}-${r.model}`}
            data-testid="roster-row"
            className={cn(
              COLS,
              'group rounded-sm py-1',
              dragging === i && 'opacity-50',
              over === i && dragging !== null && dragging !== i && 'bg-hover',
            )}
          >
            <button
              type="button"
              aria-label={`${i + 1} 番目を動かす（Alt+↑↓）`}
              // Pointer events, not HTML5 drag and drop: the desktop webview (WebView2)
              // keeps HTML5 drags for its own file drop.
              onPointerDown={(e) => {
                if (e.button !== 0) return;
                e.currentTarget.setPointerCapture(e.pointerId);
                setDragging(i);
                setOver(i);
              }}
              onPointerMove={(e) => {
                if (dragging === null) return;
                setOver(rowAt(e.currentTarget.closest('ol'), e.clientY));
              }}
              onPointerUp={() => {
                if (dragging !== null && over !== null) move(dragging, over);
                setDragging(null);
                setOver(null);
              }}
              onPointerCancel={() => {
                setDragging(null);
                setOver(null);
              }}
              onKeyDown={(e) => {
                if (!e.altKey || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown')) return;
                e.preventDefault();
                const to = e.key === 'ArrowUp' ? i - 1 : i + 1;
                if (to >= 0 && to < rules.length) move(i, to);
              }}
              className="flex cursor-grab touch-none items-center text-fg-3 hover:text-fg-2 active:cursor-grabbing"
            >
              <GripVertical size={14} strokeWidth={1.75} />
            </button>
            <span className="text-center text-meta text-fg-3 tabular">{i + 1}</span>
            <ModelSelect
              value={r.model}
              models={usable}
              label={`${i + 1} 番目のモデル`}
              onChange={(model) => save(rules.map((x, j) => (j === i ? { ...x, model } : x)))}
            />
            <input
              aria-label={`${i + 1} 番目を使うとき`}
              className={whenClass}
              defaultValue={r.when}
              key={`when-${i}-${r.when}`}
              placeholder="こういうとき（例：画面の設計）"
              maxLength={200}
              onBlur={(e) => {
                const when = e.target.value.trim();
                if (when !== r.when) save(rules.map((x, j) => (j === i ? { ...x, when } : x)));
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') e.currentTarget.blur();
              }}
            />
            <Price info={info(r.model)} />
            <Tooltip content="外す">
              <button
                type="button"
                aria-label={`${i + 1} 番目を外す`}
                onClick={() => save(rules.filter((_, j) => j !== i))}
                className="flex items-center text-fg-3 opacity-0 group-focus-within:opacity-100 group-hover:opacity-100 hover:text-fg focus-visible:opacity-100"
              >
                <X size={13} strokeWidth={1.75} />
              </button>
            </Tooltip>
          </li>
        ))}
      </ol>
      {addable && rules.length < 20 && (
        <button
          type="button"
          onClick={() => save([...rules, { model: addable.id, when: '' }])}
          className="ml-11 flex h-7 w-fit items-center gap-1.5 text-meta text-fg-3 hover:text-fg-2"
        >
          <Plus size={13} strokeWidth={1.75} />
          モデルを足す
        </button>
      )}
      <div
        data-testid="roster-otherwise"
        className={cn(COLS, 'mt-1 border-t border-line pt-2')}
      >
        <Lock size={13} strokeWidth={1.75} className="text-fg-3" aria-hidden />
        <span />
        <ModelSelect
          value={base}
          models={usable}
          label="それ以外のモデル"
          onChange={(model) => onSave({ defaultModel: model })}
        />
        <span className="truncate px-2 text-meta text-fg-2">それ以外・あなたの会話もこれで始まる</span>
        {base ? <Price info={info(base)} /> : <span />}
        <span />
      </div>
    </div>
  );
}

/** Index of the roster row at a height on screen (above the first: 0, below the last: last). */
function rowAt(list: Element | null, clientY: number): number {
  const rows = [...(list?.querySelectorAll('[data-testid="roster-row"]') ?? [])];
  const i = rows.findIndex((row) => clientY < row.getBoundingClientRect().bottom);
  return i === -1 ? Math.max(0, rows.length - 1) : i;
}

/** The "when" of a row: plain text in the list, a field when pointed at or focused. */
const whenClass =
  'h-7 min-w-0 rounded-sm border border-transparent bg-transparent px-2 text-meta text-ellipsis text-fg transition-colors duration-[120ms] placeholder:text-fg-4 hover:border-line focus:border-[var(--focus-ring)] focus:outline-none';

/**
 * Input and output as two right-aligned columns: with two decimals everywhere the points of
 * the rows line up. A word (契約枠, —) takes both and keeps to the right edge.
 */
const PRICE_COLS = 'grid grid-cols-2 gap-2 text-right text-meta whitespace-nowrap tabular';

/** The list price of one model: input and output per 1M tokens, or one word. */
function Price({ info }: { info: ModelInfo | undefined }) {
  const parts = priceParts(info);
  return (
    <Tooltip content={parts ? PRICE_UNIT : null}>
      <span className={cn(PRICE_COLS, 'text-fg-2')} data-testid="roster-cost">
        {parts ? (
          <>
            <span>{parts[0]}</span>
            <span>{parts[1]}</span>
          </>
        ) : (
          <span className="col-span-2 text-fg-3">{priceText(info)}</span>
        )}
      </span>
    </Tooltip>
  );
}

/** A model chip that opens a searchable list (one per roster row). */
function ModelSelect({
  value,
  models,
  label,
  onChange,
}: {
  value: string | null;
  models: ModelInfo[];
  label: string;
  onChange: (model: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const current = value ? models.find((m) => m.id === value) : undefined;
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={label}
          className="flex h-7 min-w-0 items-center gap-1 rounded-sm bg-surface px-2 text-meta text-fg transition-shadow duration-[120ms] hover:shadow-[inset_0_0_0_1px_var(--border-strong)]"
        >
          <span className="min-w-0 flex-1 truncate text-left">
            {value ? (current?.label ?? value) : '選ぶ'}
          </span>
          <ChevronDown size={11} strokeWidth={2} className="shrink-0 text-fg-4" />
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-[340px]">
        <Command loop>
          <Command.Input
            placeholder="モデルを検索…"
            className="h-9 w-full border-b border-line-subtle bg-transparent px-3 text-ui text-fg placeholder:text-fg-4"
          />
          <Command.List className="max-h-72 overflow-y-auto p-1">
            <Command.Empty className="px-3 py-4 text-ui text-fg-3">一致するモデルはありません</Command.Empty>
            {models.map((m) => (
              <Command.Item
                key={m.id}
                value={`${m.id} ${m.label ?? ''} ${m.provider ?? ''}`}
                onSelect={() => {
                  onChange(m.id);
                  setOpen(false);
                }}
                className="flex h-8 items-center gap-2 rounded-sm px-2 text-ui text-fg data-[selected=true]:bg-selected"
              >
                <span className="w-4 text-accent">{m.id === value && <Check size={13} />}</span>
                <span className="min-w-0 flex-1 truncate">{m.label ?? m.id}</span>
                {m.provider && <span className="text-meta text-fg-3">{m.provider}</span>}
                <span className="w-[104px] text-right text-meta text-fg-3 tabular">{priceText(m)}</span>
              </Command.Item>
            ))}
          </Command.List>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
