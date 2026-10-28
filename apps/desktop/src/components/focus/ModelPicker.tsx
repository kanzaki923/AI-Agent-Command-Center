import type { ModelInfo } from '@acc/protocol';
import { Command } from 'cmdk';
import { Check, ChevronDown, Cpu } from 'lucide-react';
import { useModels } from '../../daemon/queries';
import { cn } from '../../lib/cn';
import { useUi } from '../../store/ui';
import { Kbd } from '../ui/Kbd';
import { Popover, PopoverContent, PopoverTrigger } from '../ui/Menu';
import { relativeCost, shortModel } from '../../lib/models';


/** Model chip + cmdk popover (Ctrl+M). Recently used models first. */
export function ModelPicker({
  value,
  fallback,
  onChange,
  disabled,
}: {
  value: string | null;
  fallback: string | null;
  onChange: (model: string) => void;
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
  const sorted = [...list].sort((a, b) => {
    const ra = recentModels.indexOf(a.id);
    const rb = recentModels.indexOf(b.id);
    return (ra === -1 ? 99 : ra) - (rb === -1 ? 99 : rb);
  });
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          disabled={disabled}
          className="flex h-6 items-center gap-1.5 rounded-xs px-1.5 text-meta text-fg-2 hover:bg-hover hover:text-fg disabled:text-fg-4"
        >
          <Cpu size={12} strokeWidth={1.75} className="text-fg-3" />
          {current ? shortModel(current) || current : 'モデル未設定'}
          <ChevronDown size={11} strokeWidth={1.75} className="text-fg-4" />
        </button>
      </PopoverTrigger>
      <PopoverContent side="top" className="w-72">
        <Command loop>
          <Command.Input
            placeholder="モデルを検索…"
            className="h-9 w-full border-b border-line-subtle bg-transparent px-3 text-ui text-fg placeholder:text-fg-4"
          />
          <Command.List className="max-h-72 overflow-y-auto p-1">
            <Command.Empty className="px-3 py-4 text-ui text-fg-3">
              {models.data?.source === 'none' || list.length === 0
                ? 'モデル一覧を取得できませんでした。設定で LiteLLM の接続を確認してください。'
                : '一致するモデルはありません'}
            </Command.Empty>
            {sorted.map((m) => (
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
                <span className={cn('w-7 text-right text-meta tabular', 'text-fg-4')}>{relativeCost(m.id)}</span>
              </Command.Item>
            ))}
          </Command.List>
          <div className="flex h-7 items-center justify-end gap-1.5 border-t border-line-subtle px-2 text-micro text-fg-4">
            <Kbd id="modelPicker" /> で開く
          </div>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
