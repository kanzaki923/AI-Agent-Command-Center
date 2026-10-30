import type { CostSummary, ModelInfo, ModelRule, SettingsView } from '@acc/protocol';
import { Command } from 'cmdk';
import { Check, ChevronDown, GripVertical, Lock, Plus, X } from 'lucide-react';
import { useState } from 'react';
import { useCostSummary } from '../../daemon/cost';
import { useModels } from '../../daemon/queries';
import { cn } from '../../lib/cn';
import { shortModel } from '../../lib/models';
import { inputClass } from '../ui/Dialog';
import { Popover, PopoverContent, PopoverTrigger } from '../ui/Menu';
import { Tooltip } from '../ui/Tooltip';

/**
 * The model roster (snapshot 20261030_model-roster-spec.md): rows read top to bottom, the
 * first whose "when" fits a piece of work gives its model; the last row ("それ以外") is
 * `defaultModel`, where the person's own conversations start too. Each row shows what a
 * typical run costs and what the model cost in the last 30 days, so cost stays in view.
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

/** `契約枠` / `約 $0.48/回` / `—`: a typical run on the model (ModelInfo.runUsd). */
export function runCostText(info: ModelInfo | undefined): string {
  if (!info || info.runUsd === undefined || info.runUsd === null) return '—';
  if (info.runUsd === 0) return info.provider === 'chatgpt' ? '契約枠' : '$0';
  const v = info.runUsd < 0.1 ? info.runUsd.toFixed(3) : info.runUsd.toFixed(2);
  return `約 $${v}/回`;
}

/** Move one item of a list from `from` to `to`. */
export function moveItem<T>(list: readonly T[], from: number, to: number): T[] {
  const next = [...list];
  const [item] = next.splice(from, 1);
  if (item === undefined) return next;
  next.splice(Math.max(0, Math.min(to, next.length)), 0, item);
  return next;
}

export function ModelRosterPanel({
  settings,
  onSave,
}: {
  settings: SettingsView | undefined;
  onSave: (patch: RosterPatch) => void;
}) {
  const models = useModels().data?.models ?? [];
  const spend = useCostSummary({ range: '30d', groupBy: 'model' }).data;
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
      <ol className="flex flex-col" aria-label="使うモデル（上から順に、最初に当てはまったもの）">
        {rules.map((r, i) => (
          <li
            key={`${i}-${r.model}`}
            data-testid="roster-row"
            className={cn(
              'grid grid-cols-[16px_14px_minmax(0,150px)_minmax(0,1fr)_88px_20px] items-center gap-2 rounded-sm py-1.5',
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
              className={cn(inputClass, 'h-7 min-w-0 text-meta')}
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
            <Cost info={info(r.model)} spend={spend} model={r.model} />
            <Tooltip content="外す">
              <button
                type="button"
                aria-label={`${i + 1} 番目を外す`}
                onClick={() => save(rules.filter((_, j) => j !== i))}
                className="flex items-center text-fg-3 hover:text-fg-2"
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
          className="flex h-7 w-fit items-center gap-1.5 text-meta text-fg-3 hover:text-fg-2"
        >
          <Plus size={13} strokeWidth={1.75} />
          モデルを足す
        </button>
      )}
      <div
        data-testid="roster-otherwise"
        className="mt-1 grid grid-cols-[16px_14px_minmax(0,150px)_minmax(0,1fr)_88px_20px] items-center gap-2 border-t border-line pt-2"
      >
        <Lock size={13} strokeWidth={1.75} className="text-fg-3" aria-hidden />
        <span />
        <ModelSelect
          value={base}
          models={usable}
          label="それ以外のモデル"
          onChange={(model) => onSave({ defaultModel: model })}
        />
        <span className="truncate text-meta text-fg-2">それ以外・あなたの会話もこれで始まる</span>
        {base ? <Cost info={info(base)} spend={spend} model={base} /> : <span />}
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

/** A typical run and the last 30 days of one model, right-aligned. */
function Cost({
  info,
  spend,
  model,
}: {
  info: ModelInfo | undefined;
  spend: CostSummary | undefined;
  model: string;
}) {
  const used = spend?.rows.find((row) => row.key === model);
  return (
    <span className="flex flex-col items-end leading-tight whitespace-nowrap tabular" data-testid="roster-cost">
      <span className="text-meta text-fg-2">{runCostText(info)}</span>
      {used && used.usd > 0 && (
        <Tooltip content="ここ 30 日の費用">
          <span className="text-micro text-fg-3">
            30 日 {used.estimated ? '≈' : ''}${used.usd < 10 ? used.usd.toFixed(2) : used.usd.toFixed(1)}
          </span>
        </Tooltip>
      )}
    </span>
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
          className="flex h-7 min-w-0 items-center gap-1 rounded-sm border border-line px-2 text-meta text-fg hover:bg-hover"
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
                <span className="w-[72px] text-right text-meta text-fg-3 tabular">{runCostText(m)}</span>
              </Command.Item>
            ))}
          </Command.List>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
