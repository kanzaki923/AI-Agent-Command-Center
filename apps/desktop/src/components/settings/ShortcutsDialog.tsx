import { SCOPE_LABEL, SHORTCUTS, type ShortcutId } from '../../lib/shortcuts';
import { useUi } from '../../store/ui';
import { Dialog } from '../ui/Dialog';
import { Kbd } from '../ui/Kbd';

const SCOPES = Object.keys(SCOPE_LABEL) as (keyof typeof SCOPE_LABEL)[];

/** `?` — every shortcut, read from shortcuts.ts (the single definition). */
export function ShortcutsDialog() {
  const open = useUi((s) => s.shortcutsOpen);
  const setOpen = useUi((s) => s.setShortcutsOpen);
  const ids = Object.keys(SHORTCUTS) as ShortcutId[];
  return (
    <Dialog open={open} onOpenChange={setOpen} title="ショートカット一覧" className="w-[680px]">
      <div className="grid grid-cols-2 gap-x-8 gap-y-5">
        {SCOPES.map((scope) => (
          <section key={scope}>
            <h3 className="mb-1.5 text-micro text-fg-3">{SCOPE_LABEL[scope]}</h3>
            <div className="flex flex-col">
              {ids
                .filter((id) => SHORTCUTS[id].scope === scope)
                .map((id) => (
                  <div key={id} className="flex h-7 items-center justify-between gap-3 text-ui">
                    <span className="truncate text-fg-2">{SHORTCUTS[id].label}</span>
                    <Kbd id={id} />
                  </div>
                ))}
            </div>
          </section>
        ))}
        <section>
          <h3 className="mb-1.5 text-micro text-fg-3">Esc の順番</h3>
          <ol className="list-decimal pl-4 text-meta leading-5 text-fg-3">
            <li>パレット・メニュー・ダイアログを閉じる</li>
            <li>名前の変更などを取り消す</li>
            <li>生成中のチャットを停止する</li>
            <li>入力欄から一覧に戻る</li>
            <li>オーバーレイの詳細パネルを閉じる</li>
            <li>フォーカスから元の画面に戻る</li>
          </ol>
        </section>
      </div>
    </Dialog>
  );
}
