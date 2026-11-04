import type { Approval, SessionBrief, SessionCard, SessionState, WakeItemView } from '@acc/protocol';
import {
  BookmarkPlus,
  ChevronRight,
  Circle,
  CircleCheck,
  Coins,
  CornerDownLeft,
  Diamond,
  ShieldCheck,
  ShieldX,
  UsersRound,
} from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { keepMember, useAllMembers } from '../../daemon/members';
import { useProjects, useWorkspace } from '../../daemon/queries';
import { useRuntime } from '../../daemon/runtime';
import { toast } from '../../store/toast';
import { cn } from '../../lib/cn';
import { formatClock } from '../../lib/format';
import { describeApproval } from '../../model/approval';
import { STATE_META, sessionTitle } from '../../lib/states';
import { useUi } from '../../store/ui';
import { WorkspaceIcon } from '../ui/SemanticIcons';
import { StateIcon } from '../ui/StateIcon';
import { Tooltip } from '../ui/Tooltip';
import type { ToolCallView } from '../../model/chat';
import { spawnRequest, spawnedSessionId, stripMachineBlocks } from './conversation';
import { SpeakerMark, Speech, type Voice, speakerTones, useMemberVoice, useSpeakerTones } from './Speech';

const NONE: never[] = [];

/** Last segment of a path (`C:\work\market` → `market`). */
export function pathTail(path: string): string {
  const parts = path.replace(/\\/g, '/').split('/').filter(Boolean);
  return parts.at(-1) ?? path;
}

/** Where a session works, as an icon and a short name (nothing for a scratch folder). */
function WorkspaceTag({ workspaceId }: { workspaceId: string | null }) {
  const ws = useWorkspace(workspaceId).data ?? null;
  const projects = useProjects().data ?? NONE;
  if (!ws || ws.kind === 'scratch') return null;
  const code = ws.kind === 'worktree' || ws.kind === 'main';
  const name = code ? (projects.find((p) => p.id === ws.projectId)?.name ?? pathTail(ws.path)) : pathTail(ws.path);
  return (
    <Tooltip content={ws.path}>
      <span className="flex min-w-0 items-center gap-1 text-meta text-fg-3" data-testid="brief-workspace">
        <WorkspaceIcon kind={code ? 'worktree' : 'folder'} size={12} />
        <span className="truncate">{name}</span>
      </span>
    </Tooltip>
  );
}

/**
 * The request card (spec §5.2): what a child was asked to do. The goal (two lines, the rest on
 * click), the conditions for done as a checklist (checked once it has delivered its outputs),
 * and where it works (the budget is in the head, right above). The raw request text and
 * machine blocks stay hidden.
 */
export function BriefCard({
  brief,
  card,
  workspaceId,
  speaker = null,
}: {
  brief: SessionBrief;
  /** The session's tree card (state, outputs, budget), when known. */
  card: SessionCard | null;
  workspaceId: string | null;
  /** A speaker's character: who it plays, above what it was asked first. */
  speaker?: { title: string; persona: string; tone: number | Voice | undefined } | null;
}) {
  const [open, setOpen] = useState(false);
  const goal = stripMachineBlocks(brief.goal);
  const delivered = !!card && card.outputs.length > 0 && (card.state === 'done' || card.state === 'review');
  const long = goal.length > 120 || goal.split('\n').length > 2;
  return (
    <section aria-label="依頼" data-brief className="flex flex-col gap-2 rounded-md border border-line bg-surface px-3.5 py-2.5">
      <div className="flex h-4 items-center gap-3 text-micro text-fg-3">
        <span>依頼</span>
        <span className="flex-1" />
        <WorkspaceTag workspaceId={workspaceId} />
      </div>
      {speaker && (
        <div data-persona className="flex items-start gap-2 border-b border-line-subtle pb-2">
          <SpeakerMark title={speaker.title} tone={speaker.tone} />
          <span className="selectable min-w-0 text-ui whitespace-pre-wrap text-fg-2">{speaker.persona}</span>
        </div>
      )}
      <div
        role={long ? 'button' : undefined}
        tabIndex={long ? 0 : undefined}
        aria-expanded={long ? open : undefined}
        onClick={long ? () => setOpen((v) => !v) : undefined}
        onKeyDown={
          long
            ? (e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  setOpen((v) => !v);
                }
              }
            : undefined
        }
        className={cn('selectable text-chat whitespace-pre-wrap text-fg', !open && 'line-clamp-2', long && 'cursor-pointer')}
      >
        {goal}
      </div>
      {brief.doneWhen.length > 0 && (
        <ul aria-label="完了条件" className="flex flex-col gap-1">
          {brief.doneWhen.map((c, i) => (
            <li key={i} className="flex items-start gap-2 text-ui text-fg-2" data-done={delivered || undefined}>
              {delivered ? (
                <CircleCheck size={14} strokeWidth={1.75} className="mt-0.5 shrink-0 text-st-done" aria-label="済み" />
              ) : (
                <Circle size={14} strokeWidth={1.75} className="mt-0.5 shrink-0 text-fg-4" aria-label="未" />
              )}
              <span className="min-w-0">{c}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** A change in a wake-up, as the state it moved the child to (or its own mark). */
const CHANGE_STATE: Partial<Record<WakeItemView['change'], SessionState>> = {
  done: 'done',
  failed: 'failed',
  review: 'review',
  needs_you: 'needs_you',
  stopped: 'stopped',
  resume: 'working',
};

function ChangeIcon({ change }: { change: WakeItemView['change'] }) {
  const state = CHANGE_STATE[change];
  if (state) return <StateIcon state={state} size={13} />;
  if (change === 'budget') {
    return (
      <span role="img" aria-label="予算" className="inline-flex text-st-needs_you">
        <Coins size={13} strokeWidth={1.75} aria-hidden />
      </span>
    );
  }
  return (
    <span role="img" aria-label="回答" className="inline-flex text-fg-2">
      <CornerDownLeft size={13} strokeWidth={1.75} aria-hidden />
    </span>
  );
}

const CHANGE_LABEL: Record<WakeItemView['change'], string> = {
  done: STATE_META.done.label,
  failed: STATE_META.failed.label,
  review: STATE_META.review.label,
  needs_you: STATE_META.needs_you.label,
  stopped: STATE_META.stopped.label,
  resume: '再開',
  answer: '回答',
  budget: '予算',
};

/**
 * The status card (spec §5.2): a supervisor was woken because children changed. What speakers
 * said is shown as their words, one after another, so the leading conversation reads like the
 * conversation itself; every other change stays one line (icon + child) that opens into one
 * row per child (press a row to go there).
 */
export function WakeCard({ items }: { items: WakeItemView[] }) {
  const spoken = items.filter((it) => it.reply);
  const tones = useSpeakerTones(spoken[0]?.sessionId);
  if (spoken.length === 0) return <ChangesCard items={items} />;
  const rest = items.filter((it) => !it.reply);
  return (
    <section aria-label="発言" data-spoken className="flex flex-col gap-3.5">
      {spoken.map((it, i) => (
        <Speech
          key={`${it.sessionId}:${i}`}
          sessionId={it.sessionId}
          title={it.title}
          text={it.reply!.text}
          cut={it.reply!.cut}
          tone={tones.get(it.sessionId)}
        />
      ))}
      {rest.length > 0 && <ChangesCard items={rest} />}
    </section>
  );
}

function ChangesCard({ items }: { items: WakeItemView[] }) {
  const [open, setOpen] = useState(false);
  const openSession = useUi((s) => s.openSession);
  return (
    <section aria-label="状況" data-wake className="rounded-md border border-line-subtle">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="flex h-8 w-full min-w-0 items-center gap-2 rounded-md px-2.5 text-left text-ui text-fg-2 hover:bg-hover"
      >
        <ChevronRight
          size={12}
          strokeWidth={2}
          className={cn('shrink-0 text-fg-4 transition-transform duration-[120ms]', open && 'rotate-90')}
        />
        <span className="flex min-w-0 flex-1 items-center gap-3 overflow-hidden">
          {items.map((it, i) => (
            <span key={`${it.sessionId}:${i}`} className="flex min-w-0 shrink items-center gap-1">
              <ChangeIcon change={it.change} />
              <span className="truncate">{it.title}</span>
            </span>
          ))}
        </span>
      </button>
      {open && (
        <ul className="flex flex-col border-t border-line-subtle py-1">
          {items.map((it, i) => (
            <li key={`${it.sessionId}:${i}`}>
              <button
                type="button"
                onClick={() => openSession(it.sessionId)}
                className="flex h-7 w-full items-center gap-2 px-3 text-left text-ui text-fg-2 hover:bg-hover hover:text-fg"
              >
                <ChangeIcon change={it.change} />
                <span className="min-w-0 flex-1 truncate">{it.title}</span>
                <span className="shrink-0 text-meta text-fg-3">{CHANGE_LABEL[it.change]}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** What remains of an answered approval in the flow: `🛡✓ 許可 · pnpm add zod`. */
export function ApprovalLine({ approval }: { approval: Approval }) {
  const ok = approval.status === 'approved';
  const Icon = ok ? ShieldCheck : ShieldX;
  const what = describeApproval(approval).target?.split('\n')[0] ?? approval.title;
  return (
    <div className="flex h-6 min-w-0 items-center gap-1.5 text-meta text-fg-3" data-approval-line={approval.status}>
      <Icon size={13} strokeWidth={1.75} className={ok ? undefined : 'text-st-failed'} aria-hidden />
      <span className="shrink-0">{ok ? '許可' : '拒否'}</span>
      <span className="text-fg-4">·</span>
      <span className="min-w-0 truncate font-mono">{what}</span>
      {approval.resolvedAt && <span className="shrink-0 tabular">· {formatClock(approval.resolvedAt)}</span>}
    </div>
  );
}

/** A message not typed here: from the conversation that leads this one, or from a schedule. */
export function FromLine({ icon, children }: { icon: ReactNode; children: ReactNode }) {
  return <div className="flex h-4 items-center gap-1.5 text-micro text-fg-3">{icon}{children}</div>;
}

/** A session title for display, falling back to its default name. */
export function titleOrDefault(s: { title: string; kind?: 'chat' | 'agent' } | undefined): string | undefined {
  return s ? sessionTitle(s) : undefined;
}

/**
 * The plan card (ui-rework spec §4.1): the moment a supervisor split the work. One row per
 * child it started — the child's state (from the tree), its title (press to go there), the
 * first line of its request, where it works and its budget — under the supervisor's reason
 * when it recorded one. The rows read the live tree, so the card keeps saying where each
 * piece stands.
 */
export function PlanCard({
  spawns,
  rationale,
  children,
}: {
  spawns: ToolCallView[];
  rationale: string | null;
  /** The children of the conversation (its tree), to find each row's session. */
  children: readonly SessionCard[];
}) {
  const openSession = useUi((s) => s.openSession);
  const voice = useMemberVoice();
  const rows = spawns.map((call) => {
    const req = spawnRequest(call.input);
    const id = spawnedSessionId(call.output);
    const child = (id && children.find((c) => c.id === id)) || children.find((c) => c.title === req.title) || null;
    return { call, req, child };
  });
  if (rows.length > 0 && rows.every((r) => r.req.persona || r.req.speaker)) {
    return <CastCard rows={rows} rationale={rationale} tones={speakerTones(children, voice)} />;
  }
  return (
    <section aria-label="計画" data-plan className="flex flex-col rounded-md bg-surface">
      <div className="flex min-h-9 items-center gap-2 px-3 pt-2 pb-1">
        <span className="inline-flex text-st-supervising">
          <Diamond size={14} strokeWidth={1.75} fill="currentColor" fillOpacity={0.35} aria-hidden />
        </span>
        <span className="text-ui font-medium text-fg">{spawns.length} 人に任せる</span>
      </div>
      {rationale && <div className="selectable px-3 pb-1 text-meta text-fg-2">{rationale}</div>}
      <ul className="flex flex-col py-1">
        {rows.map(({ call, req, child }) => {
          const state: SessionState = child?.state ?? 'queued';
          const Ws = req.workspace === 'none' ? null : WorkspaceIcon;
          return (
            <li key={call.id}>
              <button
                type="button"
                data-plan-row={child?.id ?? undefined}
                disabled={!child}
                onClick={() => child && openSession(child.id)}
                className="grid h-8 w-full grid-cols-[14px_minmax(120px,0.9fr)_minmax(0,1.6fr)_auto] items-center gap-2.5 px-3 text-left text-ui enabled:hover:bg-hover"
              >
                <StateIcon state={state} size={13} />
                <span className="min-w-0 truncate text-fg">{child ? sessionTitle(child) : req.title || '新しい子'}</span>
                <span className="min-w-0 truncate text-meta text-fg-3">{req.goal.split('\n')[0]}</span>
                <span className="flex shrink-0 items-center gap-2 text-meta text-fg-3">
                  {Ws && <Ws kind={req.workspace} size={12} />}
                  {req.doneWhen.length > 0 && (
                    <Tooltip content={req.doneWhen.join('、')}>
                      <span className="inline-flex items-center gap-0.5 tabular">
                        <Circle size={10} strokeWidth={2} aria-hidden />
                        {req.doneWhen.length}
                      </span>
                    </Tooltip>
                  )}
                  {req.budgetUsd != null && <span className="tabular">${Number.isInteger(req.budgetUsd) ? req.budgetUsd : req.budgetUsd.toFixed(2)}</span>}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/**
 * The cast card: a supervisor brought speakers together (every child it started has a
 * persona). One row per speaker — its mark, its name (press to go there) and who it plays —
 * under the supervisor's reason when it recorded one.
 */
function CastCard({
  rows,
  rationale,
  tones,
}: {
  rows: { call: ToolCallView; req: ReturnType<typeof spawnRequest>; child: SessionCard | null }[];
  rationale: string | null;
  tones: Map<string, Voice>;
}) {
  const openSession = useUi((s) => s.openSession);
  const members = useAllMembers();
  return (
    <section aria-label="話し手" data-cast className="flex flex-col rounded-md bg-surface">
      <div className="flex min-h-9 items-center gap-2 px-3 pt-2 pb-1">
        <UsersRound size={14} strokeWidth={1.75} className="text-fg-2" aria-hidden />
        <span className="text-ui font-medium text-fg">{rows.length} 人で話す</span>
      </div>
      {rationale && <div className="selectable px-3 pb-1 text-meta text-fg-2">{rationale}</div>}
      <ul className="flex flex-col py-1">
        {rows.map(({ call, req, child }, i) => {
          const title = child ? sessionTitle(child) : req.title || '話し手';
          const memberId = child?.characterId ?? req.characterId;
          const member = memberId ? members.find((m) => m.id === memberId) : undefined;
          const line = (member?.profile ?? req.persona ?? '').split('\n')[0];
          return (
            <li key={call.id} className="group/cast relative">
              <button
                type="button"
                data-cast-row={child?.id ?? undefined}
                disabled={!child}
                onClick={() => child && openSession(child.id)}
                className="grid min-h-8 w-full grid-cols-[20px_minmax(80px,0.5fr)_minmax(0,2fr)] items-center gap-2.5 px-3 py-1 text-left text-ui enabled:hover:bg-hover"
              >
                <SpeakerMark title={title} tone={child ? tones.get(child.id) : i} />
                <span className="min-w-0 truncate text-fg">{title}</span>
                <span className="min-w-0 truncate text-meta text-fg-3">{line}</span>
              </button>
              {child && !member && req.persona && <KeepButton sessionId={child.id} name={title} />}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/** Keep a speaker made on the spot as a member of the roster (it then has a page and a face). */
function KeepButton({ sessionId, name }: { sessionId: string; name: string }) {
  const rt = useRuntime();
  const openMember = useUi((s) => s.openMember);
  return (
    <Tooltip content="名簿に残す">
      <button
        type="button"
        data-keep={sessionId}
        aria-label={`「${name}」を名簿に残す`}
        onClick={() =>
          void keepMember(rt, sessionId).then((m) => {
            if (!m) return;
            toast({
              title: `「${m.name}」を名簿に残しました`,
              tone: 'success',
              sticky: false,
              action: { label: '開く', run: () => openMember(m.id) },
            });
          })
        }
        className="absolute top-1/2 right-2 flex size-6 -translate-y-1/2 items-center justify-center rounded-sm text-fg-3 opacity-0 group-hover/cast:opacity-100 hover:bg-selected hover:text-fg focus-visible:opacity-100"
      >
        <BookmarkPlus size={14} strokeWidth={1.75} aria-hidden />
      </button>
    </Tooltip>
  );
}
