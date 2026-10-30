import type { ModelInfo } from '@acc/protocol';
import { Command } from 'cmdk';
import { Check, ChevronDown, Cpu } from 'lucide-react';
import { useModels } from '../../daemon/queries';
import { relativeCost, shortModel } from '../../lib/models';
import { useUi } from '../../store/ui';
import { runCostText } from '../settings/ModelRoster';
import { Kbd } from '../ui/Kbd';
import { Tooltip } from '../ui/Tooltip';
import { Popover, PopoverContent, PopoverTrigger } from '../ui/Menu';

const GROUP_HEADING =
  '[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:pt-1.5 [&_[cmdk-group-heading]]:pb-1 [&_[cmdk-group-heading]]:text-micro [&_[cmdk-group-heading]]:text-fg-3';

/**
 * Model chip + cmdk popover (Ctrl+M). The models of the roster (settings → モデル) come first
 * in its order, then the rest with recently used ones first. Without a model of its own the
 * conversation follows the roster's last row (`fallback`). With `autoLabel` the first row is
 * "no choice" (null): e.g. a new request, where the assistant picks from the roster.
 */
export function ModelPicker({
  value,
  fallback,
  roster = [],
  autoLabel,
  autoHint,
  note,
  side = 'top',
  align = 'start',
  onChange,
  disabled,
}: {
  value: string | null;
  fallback: string | null;
  /** Models of the roster in its order, the last row included. */
  roster?: readonly string[];
  /** Name of a first row that chooses nothing (onChange(null)). */
  autoLabel?: string;
  /** Tooltip of the chip while nothing is chosen (what `autoLabel` means). */
  autoHint?: string;
  /** One line above the list (e.g. what changing the model mid-conversation costs). */
  note?: string | null;
  side?: 'top' | 'bottom';
  align?: 'start' | 'end';
  onChange: (model: string | null) => void;
  disabled?: boolean;
}) {
  const open = useUi((s) => s.modelPickerOpen);
  const setOpen = useUi((s) => s.setModelPickerOpen);
  const recent = useUi((s) => s.recentCommands);
  const rememberCommand = useUi((s) => s.rememberCommand);
  const models = useModels();
  const list: ModelInfo[] = models.data?.models ?? [];
  const current = value ?? fallback;
  const recentModels = recent.filter((c) => c.startsWith('model:')).map((c) => c.slice(6));
  const inRoster = roster.flatMap((id) => list.find((m) => m.id === id) ?? []);
  const rest = list
    .filter((m) => !roster.includes(m.id))
    .sort((a, b) => {
      const ra = recentModels.indexOf(a.id);
      const rb = recentModels.indexOf(b.id);
      return (ra === -1 ? 99 : ra) - (rb === -1 ? 99 : rb);
    });
  const item = (m: ModelInfo) => (
    <Command.Item
      key={m.id}
      value={`${m.id} ${m.label ?? ''} ${m.provider ?? ''}`}
      onSelect={() => {
        onChange(m.id);
        rememberCommand(`model:${m.id}`);
        setOpen(false);
      }}
      className="flex h-8 items-center gap-2 rounded-sm px-2 text-ui text-fg data-[selected=true]:bg-selected"
    >
      <span className="w-4 text-accent">{m.id === current && <Check size={13} />}</span>
      <span className="min-w-0 flex-1 truncate">{m.label ?? m.id}</span>
      {m.provider && <span className="text-meta text-fg-3">{m.provider}</span>}
      <span className="w-[72px] text-right text-meta text-fg-3 tabular">
        {m.runUsd === undefined ? relativeCost(m.id) : runCostText(m)}
      </span>
    </Command.Item>
  );
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <Tooltip content={current === null && autoHint ? autoHint : null}>
        <PopoverTrigger asChild>
          <button
            type="button"
            disabled={disabled}
            className="flex h-6 items-center gap-1.5 rounded-xs px-1.5 text-meta text-fg-2 hover:bg-hover hover:text-fg disabled:text-fg-4"
          >
            <Cpu size={12} strokeWidth={2} className="text-fg-3" />
            {current ? shortModel(current) || current : (autoLabel ?? 'モデル')}
            <ChevronDown size={11} strokeWidth={2} className="text-fg-4" />
          </button>
        </PopoverTrigger>
      </Tooltip>
      <PopoverContent side={side} align={align} className="w-[380px]">
        <Command loop>
          <Command.Input
            placeholder="モデルを検索…"
            className="h-9 w-full border-b border-line-subtle bg-transparent px-3 text-ui text-fg placeholder:text-fg-4"
          />
          {note && (
            <div
              className="border-b border-line-subtle px-3 py-1.5 text-micro text-fg-3"
              data-testid="model-note"
            >
              {note}
            </div>
          )}
          <Command.List className={`max-h-72 overflow-y-auto p-1 ${GROUP_HEADING}`}>
            <Command.Empty className="px-3 py-4 text-ui text-fg-3">
              {models.data?.source === 'none' || list.length === 0
                ? 'モデル一覧を取得できませんでした。設定で接続を確認してください。'
                : '一致するモデルはありません'}
            </Command.Empty>
            {autoLabel && (
              <Command.Item
                value={autoLabel}
                onSelect={() => {
                  onChange(null);
                  setOpen(false);
                }}
                className="flex h-8 items-center gap-2 rounded-sm px-2 text-ui text-fg data-[selected=true]:bg-selected"
              >
                <span className="w-4 text-accent">{current === null && <Check size={13} />}</span>
                <span className="min-w-0 flex-1 truncate">{autoLabel}</span>
              </Command.Item>
            )}
            {inRoster.length > 0 ? (
              <>
                <Command.Group heading="使うモデル">{inRoster.map(item)}</Command.Group>
                {rest.length > 0 && <Command.Group heading="ほか">{rest.map(item)}</Command.Group>}
              </>
            ) : (
              rest.map(item)
            )}
          </Command.List>
          <div className="flex h-7 items-center justify-end gap-1.5 border-t border-line-subtle px-2 text-micro text-fg-3">
            <Kbd id="modelPicker" /> で開く
          </div>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
