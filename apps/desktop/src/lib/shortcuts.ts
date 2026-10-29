import { isMac } from './platform';

/**
 * The single definition of keyboard shortcuts (ui-design §7.2, §11). Buttons, the palette
 * and the shortcut list all read labels from here. `Mod` = Ctrl (Windows/Linux) / ⌘ (macOS).
 */
export const SHORTCUTS = {
  palette: { keys: 'Mod+K', label: 'コマンドパレット', scope: 'global' },
  modeCommand: { keys: 'Mod+1', label: '司令室', scope: 'global' },
  modeFocus: { keys: 'Mod+2', label: 'フォーカス', scope: 'global' },
  modeTimeline: { keys: 'Mod+3', label: 'タイムライン', scope: 'global' },
  nextAttention: { keys: 'Mod+J', label: '次の要対応へ', scope: 'global' },
  prevAttention: { keys: 'Mod+Shift+J', label: '前の要対応へ', scope: 'global' },
  newChat: { keys: 'Mod+N', label: '新しいチャット', scope: 'global' },
  newAgentTask: { keys: 'Mod+Shift+N', label: '新しいエージェントタスク', scope: 'global' },
  toggleSidebar: { keys: 'Mod+B', label: 'サイドバーを切替', scope: 'global' },
  togglePanel: { keys: 'Mod+.', label: '詳細パネルを切替', scope: 'global' },
  focusComposer: { keys: 'Mod+L', label: 'コンポーザーにフォーカス', scope: 'global' },
  modelPicker: { keys: 'Mod+M', label: 'モデルを変更', scope: 'global' },
  filter: { keys: 'Mod+F', label: 'ビュー内を絞り込み', scope: 'global' },
  globalSearch: { keys: 'Mod+Shift+F', label: '全体検索', scope: 'global' },
  stopRun: { keys: 'Mod+Shift+Backspace', label: '選択中の Run を停止', scope: 'global' },
  back: { keys: 'Alt+ArrowLeft', label: '戻る', scope: 'global' },
  forward: { keys: 'Alt+ArrowRight', label: '進む', scope: 'global' },
  settings: { keys: 'Mod+,', label: '設定', scope: 'global' },
  regionNext: { keys: 'F6', label: '次の領域へ', scope: 'global' },
  regionPrev: { keys: 'Shift+F6', label: '前の領域へ', scope: 'global' },
  undo: { keys: 'Mod+Z', label: '直前の操作を元に戻す', scope: 'global' },

  down: { keys: 'J', label: '下へ', scope: 'list' },
  up: { keys: 'K', label: '上へ', scope: 'list' },
  first: { keys: 'Home', label: '先頭へ', scope: 'list' },
  last: { keys: 'End', label: '末尾へ', scope: 'list' },
  open: { keys: 'Enter', label: '開く', scope: 'list' },
  peek: { keys: 'Space', label: '詳細パネルで覗く', scope: 'list' },
  retry: { keys: 'R', label: '再試行', scope: 'list' },
  archive: { keys: 'E', label: 'アーカイブ', scope: 'list' },
  prevTab: { keys: '[', label: '前のタブ', scope: 'list' },
  nextTab: { keys: ']', label: '次のタブ', scope: 'list' },
  help: { keys: '?', label: 'ショートカット一覧', scope: 'list' },
  toggleTaskBoard: { keys: 'T', label: 'エージェント / Task を切替', scope: 'list' },

  runTask: { keys: 'R', label: 'このTaskを実行', scope: 'tasks' },
  reworkTask: { keys: 'F', label: 'Worker に差し戻す', scope: 'tasks' },
  cancelTask: { keys: 'Mod+Shift+Backspace', label: 'Task を中止', scope: 'tasks' },
  submitFeedback: { keys: 'Mod+Enter', label: '差し戻しを送る', scope: 'tasks' },

  approve: { keys: 'Y', label: '承認', scope: 'approval' },
  approveDanger: { keys: 'Mod+Y', label: '承認（要注意）', scope: 'approval' },
  reject: { keys: 'N', label: '拒否', scope: 'approval' },
  approveAlways: { keys: 'A', label: '承認して今後も許可（範囲を選ぶ）', scope: 'approval' },
  rememberRun: { keys: '1', label: '今後も許可: この Run', scope: 'approval' },
  rememberTask: { keys: '2', label: '今後も許可: この Task', scope: 'approval' },
  rememberProject: { keys: '3', label: '今後も許可: このプロジェクト', scope: 'approval' },
  expand: { keys: 'E', label: '詳細を展開', scope: 'approval' },

  send: { keys: 'Enter', label: '送信', scope: 'composer' },
  newline: { keys: 'Shift+Enter', label: '改行', scope: 'composer' },
} as const;

export type ShortcutId = keyof typeof SHORTCUTS;

export const SCOPE_LABEL = {
  global: 'グローバル（入力中でも有効）',
  list: '一覧（入力中以外）',
  tasks: 'Task ボード',
  approval: '承認カード',
  composer: 'コンポーザー',
} as const;

const KEY_LABEL: Record<string, string> = {
  Mod: isMac ? '⌘' : 'Ctrl',
  Shift: isMac ? '⇧' : 'Shift',
  Alt: isMac ? '⌥' : 'Alt',
  ArrowLeft: '←',
  ArrowRight: '→',
  ArrowUp: '↑',
  ArrowDown: '↓',
  Backspace: isMac ? '⌫' : 'Backspace',
  Enter: 'Enter',
  Space: 'Space',
};

/** `Mod+Shift+J` → ['Ctrl', 'Shift', 'J'] */
export function keyParts(keys: string): string[] {
  // '+' itself never appears as a key here, so a plain split is safe.
  return keys.split('+').map((k) => KEY_LABEL[k] ?? k);
}

interface KeyLike {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
}

/** Punctuation that already implies Shift on common layouts. */
const SHIFT_IMPLIED = new Set(['?', '[', ']', '{', '}']);

export function matches(e: KeyLike, keys: string): boolean {
  const parts = keys.split('+');
  const key = parts[parts.length - 1]!;
  const wantMod = parts.includes('Mod');
  const wantShift = parts.includes('Shift');
  const wantAlt = parts.includes('Alt');
  const mod = isMac ? e.metaKey : e.ctrlKey;
  const otherMod = isMac ? e.ctrlKey : e.metaKey;
  if (mod !== wantMod || otherMod) return false;
  if (e.altKey !== wantAlt) return false;
  if (!SHIFT_IMPLIED.has(key) && e.shiftKey !== wantShift) return false;
  const k = key === 'Space' ? ' ' : key;
  return e.key.toLowerCase() === k.toLowerCase();
}

export function matchShortcut(e: KeyLike, id: ShortcutId): boolean {
  return matches(e, SHORTCUTS[id].keys);
}

/** "入力中" (§7.2): single-key shortcuts are disabled while typing. */
export function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  if (tag === 'TEXTAREA') return true;
  if (tag === 'INPUT') {
    const type = (target as HTMLInputElement).type;
    return !['checkbox', 'radio', 'button', 'submit', 'range'].includes(type);
  }
  return tag === 'SELECT';
}
