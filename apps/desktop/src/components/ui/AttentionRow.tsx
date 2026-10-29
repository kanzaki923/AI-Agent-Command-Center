import type { Attention, AttentionChoice } from '@acc/protocol';
import { ChevronRight, CornerDownLeft } from 'lucide-react';
import { useState } from 'react';
import { type AttentionAnswer, respondAttention } from '../../daemon/attention';
import { useRuntime } from '../../daemon/runtime';
import { cn } from '../../lib/cn';
import { ATTENTION_META } from '../../lib/states';
import { useUi } from '../../store/ui';
import { Button } from './Button';
import { AttentionIcon } from './SemanticIcons';
import { Tooltip } from './Tooltip';

const KIND_COLOR: Record<Attention['kind'], string> = {
  question: 'var(--st-needs_you)',
  approval: 'var(--st-needs_you)',
  budget: 'var(--st-needs_you)',
  stuck: 'var(--st-needs_you)',
  failure: 'var(--st-failed)',
  review: 'var(--st-review)',
};

const TONE_VARIANT = { primary: 'primary', neutral: 'secondary', danger: 'danger' } as const;

/** Key shown on (and answering) a choice: Y / N for an approval, 1–4 otherwise. */
export function choiceKey(attention: Attention, index: number): string {
  if (attention.kind === 'approval') {
    const id = attention.choices[index]?.id;
    if (id === 'approve') return 'Y';
    if (id === 'reject') return 'N';
  }
  return String(index + 1);
}

/**
 * What a key does on a selected attention row: a choice, open the reply field (Enter), or
 * nothing. Shared by the row itself and by screens that move a selection over rows.
 */
export function attentionKeyAction(
  attention: Attention,
  key: string,
): { kind: 'choice'; choice: AttentionChoice } | { kind: 'reply' } | null {
  if (key === 'Enter') return attention.allowText ? { kind: 'reply' } : null;
  const k = key.toUpperCase();
  const i = attention.choices.findIndex((_, j) => choiceKey(attention, j) === k);
  return i === -1 ? null : { kind: 'choice', choice: attention.choices[i]! };
}

/**
 * One attention item on one line (spec §1.4): kind icon, the conversation (press to open it),
 * the title, choice buttons (1–4, approvals Y / N), a reply field when text is accepted
 * (Enter opens it) and the detail when there is one (▸). Answering is optimistic: the row
 * leaves at once and comes back with a toast if the answer fails.
 */
export function AttentionRow({
  attention,
  sessionTitle,
  compact = false,
  selected = false,
  onRespond,
  onOpenSession,
  className,
}: {
  attention: Attention;
  /** Title of the conversation it belongs to; omitted inside that conversation. */
  sessionTitle?: string;
  /** Inside a conversation (above its composer): no conversation chip, tighter. */
  compact?: boolean;
  selected?: boolean;
  /** Override the default answer (attention.respond, optimistic). */
  onRespond?: (attention: Attention, answer: AttentionAnswer) => void;
  /** Override opening the conversation (default: open it). */
  onOpenSession?: (sessionId: string) => void;
  className?: string;
}) {
  const rt = useRuntime();
  const [replying, setReplying] = useState(false);
  const [text, setText] = useState('');
  const [expanded, setExpanded] = useState(false);
  const color = KIND_COLOR[attention.kind];

  const answer = (a: AttentionAnswer) => {
    if (onRespond) onRespond(attention, a);
    else void respondAttention(rt, attention, a);
  };
  const openSession = () =>
    onOpenSession ? onOpenSession(attention.sessionId) : useUi.getState().openSession(attention.sessionId);
  const sendReply = () => {
    const t = text.trim();
    if (!t) return;
    setReplying(false);
    setText('');
    answer({ text: t });
  };

  return (
    <div
      role="group"
      aria-label={`${ATTENTION_META[attention.kind].label}: ${attention.title}`}
      data-attention-row={attention.id}
      data-selected={selected || undefined}
      tabIndex={-1}
      onKeyDown={(e) => {
        if (e.target !== e.currentTarget || e.ctrlKey || e.metaKey || e.altKey) return;
        const act = attentionKeyAction(attention, e.key);
        if (!act) return;
        e.preventDefault();
        if (act.kind === 'reply') setReplying(true);
        else answer({ choiceId: act.choice.id });
      }}
      className={cn(
        'flex flex-col rounded-md border bg-surface',
        selected ? 'ring-2 ring-[var(--focus-ring)] ring-offset-1 ring-offset-[var(--bg-canvas)]' : '',
        className,
      )}
      style={{ borderColor: `color-mix(in oklch, ${color} 45%, transparent)` }}
    >
      <div className={cn('flex min-w-0 items-center gap-2', compact ? 'h-9 px-2' : 'h-10 px-2.5')}>
        <span style={{ color }} className="flex shrink-0">
          <AttentionIcon kind={attention.kind} size={15} />
        </span>
        {sessionTitle && !compact && (
          <button
            type="button"
            onClick={openSession}
            className="max-w-48 shrink-0 truncate rounded-sm bg-selected px-1.5 text-meta text-fg-2 hover:bg-hover hover:text-fg"
          >
            {sessionTitle}
          </button>
        )}
        <span className="min-w-0 flex-1 truncate text-ui text-fg">{attention.title}</span>
        {attention.detail && (
          <Tooltip content={expanded ? '閉じる' : '詳細'}>
            <button
              type="button"
              aria-expanded={expanded}
              aria-label="詳細"
              onClick={() => setExpanded((v) => !v)}
              className="flex size-6 shrink-0 items-center justify-center rounded-sm text-fg-3 hover:bg-hover hover:text-fg"
            >
              <ChevronRight size={14} strokeWidth={1.75} className={cn('transition-transform duration-[120ms]', expanded && 'rotate-90')} />
            </button>
          </Tooltip>
        )}
        <span className="flex shrink-0 items-center gap-1.5">
          {attention.choices.map((c, i) => (
            <Button
              key={c.id}
              size="sm"
              variant={TONE_VARIANT[c.tone]}
              shortcutKeys={choiceKey(attention, i)}
              onClick={() => answer({ choiceId: c.id })}
            >
              {c.label}
            </Button>
          ))}
          {attention.allowText && !replying && (
            <Button size="sm" variant="ghost" shortcutKeys="Enter" onClick={() => setReplying(true)}>
              返信
            </Button>
          )}
        </span>
      </div>
      {expanded && attention.detail && (
        <div className="selectable border-t border-line-subtle px-3 py-2 text-ui whitespace-pre-wrap text-fg-2">{attention.detail}</div>
      )}
      {replying && (
        <div className="flex items-center gap-2 border-t border-line-subtle px-2.5 py-1.5">
          <input
            autoFocus
            value={text}
            aria-label="返信"
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.nativeEvent.isComposing || e.keyCode === 229) return;
              if (e.key === 'Enter') {
                e.preventDefault();
                sendReply();
              } else if (e.key === 'Escape') {
                e.preventDefault();
                e.stopPropagation();
                setReplying(false);
              }
            }}
            className="h-7 min-w-0 flex-1 rounded-sm border border-line bg-canvas px-2 text-ui text-fg focus:border-[var(--focus-ring)]"
          />
          <Button size="sm" variant="primary" disabled={!text.trim()} onClick={sendReply} icon={<CornerDownLeft size={12} strokeWidth={2} />}>
            送る
          </Button>
        </div>
      )}
    </div>
  );
}
