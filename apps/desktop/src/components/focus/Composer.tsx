import type { Run, Session } from '@acc/protocol';
import { ArrowUp, FileText, KeyRound, Square, X } from 'lucide-react';
import { type KeyboardEvent, useRef, useState } from 'react';
import { newChat, stop } from '../../app/commands';
import { sendMessage } from '../../daemon/actions';
import { qk } from '../../daemon/keys';
import { useGrants, useSettings } from '../../daemon/queries';
import { useConnectionState, useRuntime } from '../../daemon/runtime';
import { patchIn } from '../../daemon/sync';
import { cn } from '../../lib/cn';
import { formatClock } from '../../lib/format';
import { toastError } from '../../store/toast';
import { useUi } from '../../store/ui';
import { Kbd } from '../ui/Kbd';
import { Popover, PopoverContent, PopoverTrigger } from '../ui/Menu';
import { Tooltip } from '../ui/Tooltip';
import { ModelPicker } from './ModelPicker';

/** Pasting more than this many lines becomes an attachment chip (§6). */
export const PASTE_ATTACH_LINES = 40;

interface KeyInfo {
  key: string;
  shiftKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  isComposing: boolean;
  keyCode: number;
}

/**
 * Enter sends, Shift+Enter inserts a newline, Ctrl/⌘+Enter also sends.
 * NEVER send while an IME is composing (`isComposing` or keyCode 229): a mis-sent Japanese
 * message is the worst possible feel (§6).
 */
export function composerKeyAction(e: KeyInfo, composing = false): 'send' | 'none' {
  if (e.key !== 'Enter') return 'none';
  if (composing || e.isComposing || e.keyCode === 229) return 'none';
  if (e.shiftKey || e.altKey) return 'none';
  return 'send';
}

interface Attachment {
  id: number;
  text: string;
  lines: number;
}

function PermissionChip({ session }: { session: Session }) {
  const rt = useRuntime();
  const grants = useGrants(session.id).data ?? [];
  const active = grants.find((g) => !g.revokedAt && (!g.expiresAt || g.expiresAt > new Date().toISOString()));
  const label = active
    ? active.expiresAt
      ? `期限付き（${formatClock(active.expiresAt)} まで）`
      : active.lifetime === 'run'
        ? 'このRunのみ'
        : 'あり'
    : 'なし';
  const grant = async () => {
    try {
      await rt.client.call('grant.create', {
        subject: { kind: 'session', sessionId: session.id },
        permissions: ['*'],
        lifetime: 'session',
        expiresAt: new Date(Date.now() + 24 * 3600_000).toISOString(),
        reason: 'Granted from the composer',
      });
      void rt.queryClient.invalidateQueries({ queryKey: qk.grants(session.id) });
    } catch (err) {
      toastError(err, '権限を付与できませんでした');
    }
  };
  const revoke = async () => {
    if (!active) return;
    try {
      await rt.client.call('grant.revoke', { grantId: active.id });
      void rt.queryClient.invalidateQueries({ queryKey: qk.grants(session.id) });
    } catch (err) {
      toastError(err, '権限を取り消せませんでした');
    }
  };
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="flex h-6 items-center gap-1.5 rounded-xs px-1.5 text-meta text-fg-3 hover:bg-hover hover:text-fg-2"
        >
          <KeyRound size={12} strokeWidth={1.75} />
          Orchestrator 権限: <span className={active ? 'text-fg-2' : undefined}>{label}</span>
        </button>
      </PopoverTrigger>
      <PopoverContent side="top" className="w-80 p-3">
        <div className="text-ui font-medium text-fg">Orchestrator 権限</div>
        <p className="mt-1 text-meta text-fg-3">
          付与すると、このチャットが Task の作成や Worker の起動を行えるようになります。範囲と予算は Core Daemon が強制します。
        </p>
        <div className="mt-3 flex justify-end gap-2">
          {active ? (
            <button type="button" onClick={() => void revoke()} className="h-7 rounded-sm border border-line px-2.5 text-ui text-fg hover:bg-hover">
              権限を取り消す
            </button>
          ) : (
            <button type="button" onClick={() => void grant()} className="h-7 rounded-sm bg-accent px-2.5 text-ui font-medium text-accent-fg hover:bg-accent-hover">
              24 時間付与する
            </button>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}

export function Composer({
  session,
  activeRun,
  onSent,
}: {
  session: Session;
  activeRun: Run | null;
  onSent: () => void;
}) {
  const rt = useRuntime();
  const connected = useConnectionState() === 'open';
  const draft = useUi((s) => s.drafts[session.id] ?? '');
  const setDraft = useUi((s) => s.setDraft);
  const setModelPickerOpen = useUi((s) => s.setModelPickerOpen);
  const settings = useSettings().data;
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const composing = useRef(false);
  const textarea = useRef<HTMLTextAreaElement | null>(null);
  const generating =
    !!activeRun && (activeRun.status === 'running' || activeRun.status === 'queued' || activeRun.status === 'created');
  const canStopInline = generating && activeRun?.kind === 'chat';

  const send = () => {
    const text = draft.trim();
    const body = [text, ...attachments.map((a) => a.text)].filter(Boolean).join('\n\n');
    if (!body) return;
    if (text === '/new') {
      setDraft(session.id, '');
      void newChat(rt);
      return;
    }
    if (text === '/stop') {
      setDraft(session.id, '');
      if (activeRun) void stop(rt, activeRun);
      return;
    }
    if (text === '/model') {
      setDraft(session.id, '');
      setModelPickerOpen(true);
      return;
    }
    // Optimistic: clear in the same frame the message appears (§6).
    setDraft(session.id, '');
    setAttachments([]);
    onSent();
    void sendMessage(rt, session.id, body);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    const action = composerKeyAction(
      {
        key: e.key,
        shiftKey: e.shiftKey,
        ctrlKey: e.ctrlKey,
        metaKey: e.metaKey,
        altKey: e.altKey,
        isComposing: e.nativeEvent.isComposing,
        keyCode: e.nativeEvent.keyCode,
      },
      composing.current,
    );
    if (action === 'send') {
      e.preventDefault();
      if (connected) send();
      return;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      if (canStopInline && activeRun) void stop(rt, activeRun);
      else e.currentTarget.blur();
    }
  };

  const setModel = (model: string) => {
    patchIn<Session>(rt.queryClient, qk.sessions, session.id, (s) => ({ ...s, model }));
    rt.client.call('session.update', { sessionId: session.id, model }).catch((err: unknown) => toastError(err));
  };

  return (
    <div className="mx-auto w-full max-w-[760px] px-6 pb-4">
      <div
        className={cn(
          'rounded-md border bg-surface transition-colors duration-[120ms]',
          'border-line focus-within:border-line-strong',
        )}
        onClick={(e) => {
          // Clicking the frame focuses the input; chips and buttons keep their own focus.
          if (e.target instanceof Element && e.target.closest('button, input, textarea, a')) return;
          textarea.current?.focus();
        }}
      >
        {attachments.length > 0 && (
          <div className="flex flex-wrap gap-1.5 px-3 pt-2.5">
            {attachments.map((a) => (
              <span key={a.id} className="flex h-6 items-center gap-1.5 rounded-xs bg-selected pr-1 pl-2 text-meta text-fg-2">
                <FileText size={12} strokeWidth={1.75} />
                貼り付けたテキスト · {a.lines}行
                <button
                  type="button"
                  aria-label="添付を外す"
                  className="flex size-4 items-center justify-center rounded-xs text-fg-3 hover:text-fg"
                  onClick={() => setAttachments((list) => list.filter((x) => x.id !== a.id))}
                >
                  <X size={11} />
                </button>
              </span>
            ))}
          </div>
        )}
        <textarea
          ref={textarea}
          data-composer-input
          data-generating={canStopInline ? 'true' : undefined}
          value={draft}
          rows={1}
          onChange={(e) => setDraft(session.id, e.target.value)}
          onKeyDown={onKeyDown}
          onCompositionStart={() => {
            composing.current = true;
          }}
          onCompositionEnd={() => {
            composing.current = false;
          }}
          onPaste={(e) => {
            const text = e.clipboardData.getData('text/plain');
            const lines = text.split('\n').length;
            if (lines > PASTE_ATTACH_LINES) {
              e.preventDefault();
              setAttachments((list) => [...list, { id: Date.now(), text, lines }]);
            }
          }}
          placeholder={session.kind === 'agent' ? '追加の指示を入力…' : '何でも聞いてください'}
          aria-label="メッセージ"
          className="block max-h-[296px] min-h-[44px] w-full resize-none bg-transparent px-3.5 pt-3 pb-1 text-chat text-fg placeholder:text-fg-4 [field-sizing:content]"
        />
        <div className="flex h-8 items-center gap-1 px-2 pb-1">
          <ModelPicker value={session.model} fallback={settings?.defaultModel ?? null} onChange={setModel} />
          {session.kind === 'chat' && <PermissionChip session={session} />}
          <span className="flex-1" />
          <span className="mr-1 flex items-center gap-1 text-micro text-fg-4">
            <Kbd keys="Enter" /> 送信
          </span>
          {canStopInline ? (
            <Tooltip content="生成を停止（Esc）">
              <button
                type="button"
                aria-label="生成を停止"
                onClick={(e) => {
                  e.stopPropagation();
                  if (activeRun) void stop(rt, activeRun);
                }}
                className="flex size-7 items-center justify-center rounded-sm bg-selected text-fg hover:bg-hover"
              >
                <Square size={11} strokeWidth={2.5} fill="currentColor" />
              </button>
            </Tooltip>
          ) : (
            <Tooltip content={connected ? '送信（Enter）' : 'Core Daemon に接続していません'}>
              <span className="inline-flex">
                <button
                  type="button"
                  aria-label="送信"
                  disabled={!connected || (!draft.trim() && attachments.length === 0)}
                  onClick={(e) => {
                    e.stopPropagation();
                    send();
                  }}
                  className="flex size-7 items-center justify-center rounded-sm bg-accent text-accent-fg hover:bg-accent-hover disabled:bg-selected disabled:text-fg-4"
                >
                  <ArrowUp size={14} strokeWidth={2} />
                </button>
              </span>
            </Tooltip>
          )}
        </div>
      </div>
    </div>
  );
}
