import type { SessionRole, SessionState } from '@acc/protocol';
import {
  AlarmClock,
  Check,
  ChevronRight,
  CirclePause,
  Clock,
  Coins,
  CornerDownRight,
  Inbox,
  type LucideIcon,
  MessageSquare,
  Play,
  RotateCcw,
  TriangleAlert,
  UserRound,
  Wrench,
} from 'lucide-react';
import type { ReactNode } from 'react';
import { cn } from '../../lib/cn';
import { formatAbsolute } from '../../lib/format';
import { ATTENTION_META, STATE_META, formatUsd } from '../../lib/states';
import {
  type TimelineMoment,
  type TimelineNote,
  type TimelineOutput,
  type TimelineRun,
  type TimelineStep,
  type Tone,
  formatDuration,
  formatWhen,
} from '../../model/timeline';
import { useUi } from '../../store/ui';
import { OutputIcon, RoleIcon } from '../ui/SemanticIcons';
import { StateIcon } from '../ui/StateIcon';
import { Tooltip } from '../ui/Tooltip';

const TONE_COLOR: Record<Tone, string> = {
  neutral: 'var(--text-tertiary)',
  needs_you: 'var(--st-needs_you)',
  failed: 'var(--st-failed)',
  review: 'var(--st-review)',
  done: 'var(--st-done)',
};

/** Icon and its label (tooltip and screen readers) of a moment. */
function momentIcon(m: TimelineMoment): { icon: LucideIcon; label: string } {
  switch (m.what) {
    case 'request':
      return { icon: UserRound, label: 'あなたの依頼' };
    case 'brief':
      return { icon: CornerDownRight, label: '依頼' };
    case 'schedule':
      return { icon: Clock, label: '繰り返し' };
    case 'attention':
      return ATTENTION_META[m.attention ?? 'question'];
    case 'finished':
      return STATE_META[m.finishedAs ?? 'done'];
    case 'accepted':
      return { icon: Check, label: '採用' };
    case 'redo':
      return { icon: RotateCcw, label: 'やり直し' };
    case 'stopped':
      return { icon: CirclePause, label: '停止' };
  }
}

const STEP_ICON: Record<TimelineStep['what'], { icon: LucideIcon; label: string }> = {
  tool: { icon: Wrench, label: 'ツール' },
  reply: { icon: MessageSquare, label: '応答' },
  failure: { icon: TriangleAlert, label: '失敗' },
};

const NOTE_ICON: Record<TimelineNote['what'], { icon: LucideIcon; label: string }> = {
  inbox: { icon: Inbox, label: '受信' },
  budget: { icon: Coins, label: '予算' },
};

/** Change of a child in a wake, in the state vocabulary. */
const WAKE_STATE: Record<string, SessionState | null> = {
  done: 'done',
  failed: 'failed',
  review: 'review',
  needs_you: 'needs_you',
  stopped: 'stopped',
  answer: null,
  budget: null,
  resume: null,
};

function KindIcon({ icon: Icon, label, color, dim }: { icon: LucideIcon; label: string; color: string; dim?: boolean }) {
  return (
    <Tooltip content={label}>
      <span
        role="img"
        aria-label={label}
        className={cn('flex size-4 shrink-0 items-center justify-center', dim && 'opacity-55')}
        style={{ color }}
      >
        <Icon size={14} strokeWidth={1.9} aria-hidden />
      </span>
    </Tooltip>
  );
}

/** The conversation a row is about; pressing it opens the conversation. */
export function SessionTag({ id, title }: { id: string; title: string }) {
  return (
    <button
      type="button"
      tabIndex={-1}
      data-session-tag={id}
      onClick={(e) => {
        e.stopPropagation();
        useUi.getState().openSession(id);
      }}
      className="max-w-44 shrink-0 truncate rounded-sm bg-selected px-1.5 text-meta leading-5 text-fg-2 hover:bg-hover hover:text-fg"
    >
      {title}
    </button>
  );
}

function Outputs({ outputs }: { outputs: TimelineOutput[] }) {
  const first = outputs[0];
  if (!first) return null;
  return (
    <span className="flex min-w-0 items-center gap-1.5 text-fg">
      <OutputIcon kind={first.kind} size={13} className="text-fg-2" />
      <span className="truncate">{first.title}</span>
      {outputs.length > 1 && <span className="shrink-0 text-meta text-fg-3 tabular">+{outputs.length - 1}</span>}
    </span>
  );
}

interface RowProps {
  rowKey: string;
  ts: string;
  now: number;
  selected: boolean;
  onActivate: () => void;
  onSelect: () => void;
  indent?: boolean;
  /** Off when the row above shows the same time (one time per minute reads calmer). */
  showTime?: boolean;
  muted?: boolean;
  children: ReactNode;
  label: string;
}

/** One 28px line: time, then whatever the row is. Click jumps (or opens a run). */
function Row({ rowKey, ts, now, selected, onActivate, onSelect, indent, showTime = true, muted, children, label }: RowProps) {
  return (
    <div
      role="option"
      aria-selected={selected}
      aria-label={label}
      data-tl-row={rowKey}
      onClick={() => {
        onSelect();
        onActivate();
      }}
      className={cn(
        'group relative flex h-7 cursor-default items-center gap-2 rounded-sm pr-2 text-ui',
        selected ? 'bg-selected' : 'hover:bg-hover',
        muted ? 'text-fg-2' : 'text-fg',
      )}
    >
      {selected && <span className="absolute top-1 bottom-1 left-0 w-0.5 rounded-full bg-accent" />}
      <Tooltip content={formatAbsolute(ts)}>
        <span
          aria-hidden={indent || !showTime || undefined}
          className={cn('w-[72px] shrink-0 pr-1 text-right text-meta text-fg-3 tabular', (indent || !showTime) && 'opacity-0')}
        >
          {formatWhen(ts, now)}
        </span>
      </Tooltip>
      {indent && <span className="ml-1 h-full w-px shrink-0 bg-line-subtle" aria-hidden />}
      {children}
    </div>
  );
}

export function MomentRow({
  m,
  title,
  isRoot,
  now,
  showTime,
  selected,
  onSelect,
  onJump,
}: {
  m: TimelineMoment;
  title: string;
  isRoot: boolean;
  now: number;
  showTime: boolean;
  selected: boolean;
  onSelect: () => void;
  onJump: () => void;
}) {
  const { icon, label } = momentIcon(m);
  const color = TONE_COLOR[m.tone] === TONE_COLOR.neutral ? 'var(--text-secondary)' : TONE_COLOR[m.tone];
  const body =
    m.what === 'finished' ? (
      m.outputs.length ? <Outputs outputs={m.outputs} /> : <span className="text-fg-2">{label}</span>
    ) : (m.what === 'accepted' || m.what === 'redo') && m.outputs.length ? (
      <Outputs outputs={m.outputs} />
    ) : (
      <span className={cn('min-w-0 truncate', m.what === 'attention' && !m.open && 'text-fg-2')}>{m.text}</span>
    );
  return (
    <Row
      rowKey={m.key}
      ts={m.ts}
      now={now}
      showTime={showTime}
      selected={selected}
      onSelect={onSelect}
      onActivate={onJump}
      label={`${label}: ${title}${m.text ? ` ${m.text}` : ''}`}
    >
      <KindIcon icon={icon} label={label} color={color} dim={m.what === 'attention' && !m.open} />
      {!isRoot && <SessionTag id={m.sessionId} title={title} />}
      <span className="flex min-w-0 flex-1 items-center gap-2">{body}</span>
      {m.resolution && (
        <span
          className={cn(
            'flex max-w-56 shrink-0 items-center gap-1 rounded-sm px-1.5 text-meta leading-5',
            m.resolution.byHuman ? 'border border-line text-fg-2' : 'text-fg-3',
          )}
          data-resolution
        >
          <Check size={12} strokeWidth={2} aria-hidden />
          <span className="truncate">{m.resolution.label}</span>
        </span>
      )}
    </Row>
  );
}

export function NoteRow({
  n,
  title,
  isRoot,
  now,
  showTime,
  selected,
  onSelect,
  onJump,
}: {
  n: TimelineNote;
  title: string;
  isRoot: boolean;
  now: number;
  showTime: boolean;
  selected: boolean;
  onSelect: () => void;
  onJump: () => void;
}) {
  const { icon, label } = NOTE_ICON[n.what];
  return (
    <Row rowKey={n.key} ts={n.ts} now={now} showTime={showTime} selected={selected} onSelect={onSelect} onActivate={onJump} muted label={`${label}: ${n.text}`}>
      <KindIcon icon={icon} label={label} color={TONE_COLOR[n.tone]} />
      {!isRoot && <SessionTag id={n.sessionId} title={title} />}
      <span className="min-w-0 flex-1 truncate">{n.text}</span>
    </Row>
  );
}

function WakeItems({ items, titleOf }: { items: NonNullable<TimelineRun['wake']>; titleOf: (id: string) => string }) {
  return (
    <span className="flex min-w-0 items-center gap-3 overflow-hidden">
      {items.map((w) => {
        const st = WAKE_STATE[w.change];
        return (
          <span key={`${w.sessionId}-${w.change}`} className="flex min-w-0 shrink items-center gap-1">
            {st ? <StateIcon state={st} size={12} /> : <Play size={12} strokeWidth={2} className="shrink-0 text-fg-3" aria-hidden />}
            <span className="truncate">{titleOf(w.sessionId) || w.title}</span>
          </span>
        );
      })}
    </span>
  );
}

export function RunRow({
  r,
  title,
  isRoot,
  open,
  now,
  showTime,
  selected,
  onSelect,
  onToggle,
  onJump,
  titleOf,
}: {
  r: TimelineRun;
  title: string;
  isRoot: boolean;
  open: boolean;
  now: number;
  showTime: boolean;
  selected: boolean;
  onSelect: () => void;
  onToggle: () => void;
  /** A run with no steps yet has nothing to open: it leads to its conversation. */
  onJump: () => void;
  titleOf: (id: string) => string;
}) {
  const icon =
    r.trigger === 'wake'
      ? { icon: AlarmClock, label: '起床' }
      : r.trigger === 'schedule'
        ? { icon: Clock, label: '繰り返しの実行' }
        : { icon: Play, label: '実行' };
  const run = r.run;
  const start = run?.startedAt ?? run?.createdAt ?? r.ts;
  const end = run?.endedAt ?? (r.state === 'working' || r.state === 'needs_you' ? new Date(now).toISOString() : null);
  const duration = end ? formatDuration(Date.parse(end) - Date.parse(start)) : '';
  const cost = formatUsd(run?.usage.costUsd);
  return (
    <Row
      rowKey={r.key}
      ts={r.ts}
      now={now}
      showTime={showTime}
      selected={selected}
      onSelect={onSelect}
      onActivate={r.steps.length > 0 ? onToggle : onJump}
      muted
      label={`${icon.label}: ${title} ${r.headline}`}
    >
      <KindIcon icon={icon.icon} label={icon.label} color="var(--text-tertiary)" />
      {!isRoot && <SessionTag id={r.sessionId} title={title} />}
      <span className="flex min-w-0 flex-1 items-center">
        {r.wake?.length ? <WakeItems items={r.wake} titleOf={titleOf} /> : <span className="truncate">{r.headline}</span>}
      </span>
      <span className="flex shrink-0 items-center gap-2 text-meta text-fg-3 tabular">
        <StateIcon state={r.state} size={12} />
        {duration && <span>{duration}</span>}
        {cost && <span>{cost}</span>}
        {r.steps.length > 0 ? (
          <span className="flex w-8 items-center justify-end gap-0.5" aria-label={`${r.steps.length} 件`}>
            {r.steps.length}
            <ChevronRight
              size={13}
              strokeWidth={1.75}
              className={cn('transition-transform duration-[120ms]', open && 'rotate-90')}
              aria-hidden
            />
          </span>
        ) : (
          <span className="w-8" aria-hidden />
        )}
      </span>
    </Row>
  );
}

export function StepRow({
  s,
  now,
  selected,
  onSelect,
  onJump,
}: {
  s: TimelineStep;
  now: number;
  selected: boolean;
  onSelect: () => void;
  onJump: () => void;
}) {
  const { icon, label } = STEP_ICON[s.what];
  return (
    <Row rowKey={s.key} ts={s.ts} now={now} selected={selected} onSelect={onSelect} onActivate={onJump} indent muted label={`${label}: ${s.text}`}>
      <span className="w-3 shrink-0" aria-hidden />
      <KindIcon icon={icon} label={label} color={s.isError ? 'var(--st-failed)' : 'var(--text-tertiary)'} />
      <span className={cn('min-w-0 flex-1 truncate', s.isError && 'text-st-failed')}>{s.text}</span>
    </Row>
  );
}

/** Heading of a tree: its role, its title (opens the conversation) and its state now. */
export function GroupHeading({
  rootId,
  title,
  role,
  state,
}: {
  rootId: string;
  title: string;
  role: SessionRole;
  state: SessionState | null;
}) {
  return (
    <div className="flex h-8 items-center gap-2 pl-[80px]">
      <RoleIcon role={role} size={14} className="text-fg-2" />
      <button
        type="button"
        tabIndex={-1}
        onClick={() => useUi.getState().openSession(rootId)}
        className="min-w-0 truncate text-ui font-semibold text-fg hover:underline"
      >
        {title}
      </button>
      {state && <StateIcon state={state} size={12} />}
    </div>
  );
}
