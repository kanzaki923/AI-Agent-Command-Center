import type { Run, Session } from '@acc/protocol';
import { ArrowUp, CornerDownLeft, FileText, Square, X } from 'lucide-react';
import { motion } from 'motion/react';
import { type KeyboardEvent, useRef, useState } from 'react';
import { newChat, stop } from '../../app/commands';
import { sendMessage } from '../../daemon/actions';
import { qk } from '../../daemon/keys';
import { useSettings } from '../../daemon/queries';
import { useConnectionState, useRuntime } from '../../daemon/runtime';
import { patchIn } from '../../daemon/sync';
import { cn } from '../../lib/cn';
import { toastError } from '../../store/toast';
import { useUi } from '../../store/ui';
import { GrantChip, OrchestratorMark } from '../grant/Grant';
import { Kbd } from '../ui/Kbd';
import { Tooltip } from '../ui/Tooltip';
import { ModelPicker } from './ModelPicker';

/**
 * Suggested first message (demo): one click sends it. Shown above an empty conversation's
 * composer, never auto-sent.
 */
function SuggestionChip({ text, onSend, onDismiss }: { text: string; onSend: () => void; onDismiss: () => void }) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 4 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.18, ease: [0.16, 1, 0.3, 1] }}
      className="mb-2 flex items-center gap-2"
    >
      <button
        type="button"
        onClick={onSend}
        data-testid="suggestion-chip"
        className="group flex min-w-0 items-center gap-2 rounded-full border border-line bg-surface py-1 pr-2 pl-3 text-ui text-fg-2 hover:border-[var(--focus-ring)] hover:text-fg"
      >
        <OrchestratorMark size={11} />
        <span className="min-w-0 truncate">{text}</span>
        <span className="flex items-center gap-1 text-meta text-fg-4 group-hover:text-fg-3">
          <CornerDownLeft size={12} strokeWidth={1.75} />
          送信
        </span>
      </button>
      <button type="button" onClick={onDismiss} aria-label="提案を閉じる" className="flex size-6 items-center justify-center rounded-full text-fg-4 hover:text-fg-2">
        <X size={12} strokeWidth={1.75} />
      </button>
    </motion.div>
  );
}

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
  const setGrantDialog = useUi((s) => s.setGrantDialog);
  const suggestion = useUi((s) => s.suggestions[session.id] ?? null);
  const setSuggestion = useUi((s) => s.setSuggestion);
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
    if (text === '/orchestrate' && session.kind === 'chat') {
      setDraft(session.id, '');
      setGrantDialog(session.id);
      return;
    }
    // Optimistic: clear in the same frame the message appears (§6).
    setDraft(session.id, '');
    setAttachments([]);
    setSuggestion(session.id, null);
    onSent();
    void sendMessage(rt, session.id, body);
  };

  const sendSuggestion = () => {
    if (!suggestion || !connected) return;
    setSuggestion(session.id, null);
    onSent();
    void sendMessage(rt, session.id, suggestion);
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
      {suggestion && !generating && !draft && (
        <SuggestionChip text={suggestion} onSend={sendSuggestion} onDismiss={() => setSuggestion(session.id, null)} />
      )}
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
          {session.kind === 'chat' && <GrantChip session={session} />}
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
