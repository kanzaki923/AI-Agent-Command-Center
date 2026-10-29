import type {
  Artifact,
  AttentionKind,
  Event,
  Message,
  OutputKind,
  Run,
  RunTrigger,
  Session,
  SessionState,
  WakeItemView,
} from '@acc/protocol';
import { outputKind } from '../daemon/outputs';
import { sessionTitle } from '../lib/states';
import { describeTool, outputText, shorten } from '../lib/tools';

/**
 * The timeline (ui-redesign spec §8): what happened, told as the moments a human cares about
 * (a request, a question, a failure, a finished piece of work with its outputs, an
 * acceptance, a schedule firing), grouped by conversation tree. "詳細" adds what the agents
 * did in between: each run as one unit (its tools, replies, failures), the inbox and the
 * budget. Pure: everything is derived from the event log and the session / run caches.
 */

// ------------------------------------------------------------------------------- types

/** What a moment is; the view picks the icon and the colour from it. */
export type MomentKind =
  | 'request' // a human's message
  | 'brief' // a conversation asked a child to do something
  | 'schedule' // a schedule fired
  | 'attention' // a question / approval / failure / review / budget / stuck item
  | 'finished' // a child finished (done, or waiting for review) with its outputs
  | 'accepted' // a human accepted an output
  | 'redo' // a human asked for it to be done again
  | 'stopped'; // a human stopped a conversation tree

export type Tone = 'neutral' | 'needs_you' | 'failed' | 'review' | 'done';

export interface TimelineOutput {
  kind: OutputKind;
  title: string;
}

/** Where a row leads: the message to scroll to and flash, or just the conversation. */
export interface TimelineTarget {
  sessionId: string;
  messageId: string | null;
}

export interface TimelineMoment {
  kind: 'moment';
  key: string;
  seq: number;
  ts: string;
  /** The conversation the moment is about (its chip). */
  sessionId: string;
  rootId: string;
  what: MomentKind;
  /** Attention kind for `attention` moments; `finished` uses the state it ended in. */
  attention: AttentionKind | null;
  finishedAs: 'done' | 'review' | null;
  tone: Tone;
  /** One noun phrase (the title, the request's first line ...). */
  text: string;
  outputs: TimelineOutput[];
  /** How an attention item ended: the human's choice, or settled by itself. */
  resolution: { label: string; byHuman: boolean } | null;
  /** An attention item that is still open. */
  open: boolean;
  target: TimelineTarget;
}

export type StepKind = 'tool' | 'reply' | 'failure';

export interface TimelineStep {
  key: string;
  seq: number;
  ts: string;
  what: StepKind;
  text: string;
  isError: boolean;
  target: TimelineTarget;
}

/** One run as one unit (never split by other runs' events: the old timeline's bug 9). */
export interface TimelineRun {
  kind: 'run';
  key: string;
  seq: number;
  ts: string;
  runId: string;
  sessionId: string;
  rootId: string;
  run: Run | null;
  trigger: RunTrigger | null;
  /** What woke a supervisor (the status update it got), when this run is a wake. */
  wake: WakeItemView[] | null;
  /** The run's last reply line (or what it is doing first). */
  headline: string;
  steps: TimelineStep[];
  /** Status of the run in the session-state vocabulary (icon and colour). */
  state: SessionState;
  target: TimelineTarget;
}

export type NoteKind = 'inbox' | 'budget';

/** A detail line that belongs to no run (an inbox item, a budget threshold). */
export interface TimelineNote {
  kind: 'note';
  key: string;
  seq: number;
  ts: string;
  sessionId: string;
  rootId: string;
  what: NoteKind;
  text: string;
  tone: Tone;
  target: TimelineTarget;
}

export type TimelineItem = TimelineMoment | TimelineRun | TimelineNote;

export interface TimelineGroup {
  rootId: string;
  /** Chronological (oldest first): the tree reads like a story from the top. */
  items: TimelineItem[];
  /** Time of the newest item; groups are ordered newest first. */
  lastTs: string;
}

export interface TimelineFilters {
  /** Only this conversation's rows. */
  sessionId: string | null;
  /** Only this run (shown with its details, open). */
  runId: string | null;
  text: string;
}

export const EMPTY_FILTERS: TimelineFilters = { sessionId: null, runId: null, text: '' };

export function filtersActive(f: TimelineFilters): boolean {
  return !!f.sessionId || !!f.runId || !!f.text.trim();
}

/**
 * Sessions by id: the cached list, plus the ones it does not have (archived, or newer than
 * the list) as their creation event described them.
 */
export function knownSessions(events: readonly Event[], sessions: ReadonlyMap<string, Session>): Map<string, Session> {
  const out = new Map(sessions);
  for (const e of events) {
    if (e.type === 'session.created' && !out.has(e.payload.session.id)) out.set(e.payload.session.id, e.payload.session);
  }
  return out;
}

// ----------------------------------------------------------------------------- helpers

/** One line of a message: fenced blocks (code, plans for the mock runtime) drop out. */
export function messageLine(text: string, max = 80): string {
  const prose = text.replace(/```[\s\S]*?(?:```|$)/g, ' ').trim();
  const first = prose.split('\n').find((l) => l.trim()) ?? '';
  // Markdown marks (a heading, a list bullet, bold) are not part of the words, and a row is
  // a phrase, not a sentence (no closing 。).
  const plain = first
    .replace(/^\s*(?:#{1,6}\s+|[-*>]\s+|\d+\.\s+)/, '')
    .replace(/\*\*|__|`/g, '')
    .replace(/。\s*$/, '');
  return shorten(plain, max);
}

function textOf(m: Message): string {
  return m.content
    .filter((p) => p.type === 'text')
    .map((p) => (p as { text: string }).text)
    .join('\n');
}

/** A run status in the session-state vocabulary (one icon set for the whole app). */
export function runState(run: Run | null): SessionState {
  switch (run?.status) {
    case 'running':
      return 'working';
    case 'awaiting_approval':
      return 'needs_you';
    case 'created':
    case 'queued':
      return 'queued';
    case 'completed':
      return 'done';
    case 'failed':
      return 'failed';
    case 'cancelled':
      return 'stopped';
    default:
      return 'idle';
  }
}

/**
 * A tool use as a noun phrase, in the same words as the chat and a chip's `now`
 * (lib/tools.ts): no method name reaches the screen.
 */
export function stepPhrase(name: string, rawInput: unknown): string {
  return describeTool(name, rawInput).label;
}

const INBOX_TEXT: Record<string, string> = {
  answer: '回答',
  budget: '予算',
  resume: '再開',
  user_message: 'あなたの発言',
};

// ------------------------------------------------------------------------------- build

export interface BuildInput {
  events: readonly Event[];
  sessions: ReadonlyMap<string, Session>;
  runs: ReadonlyMap<string, Run>;
  /** "詳細": runs, inbox and budget too. */
  details: boolean;
  filters?: TimelineFilters;
}

/**
 * Turn the event log into tree groups (newest tree first, items oldest first). Moments are
 * always there; with `details` each run becomes one unit placed where it started, holding
 * every step of that run however the runs interleave.
 */
export function buildTimeline(input: BuildInput): TimelineGroup[] {
  const filters = input.filters ?? EMPTY_FILTERS;
  const details = input.details || !!filters.runId;
  const known = knownSessions(input.events, input.sessions);
  const session = (id: string) => known.get(id);
  // Events that name the tree tell it even before the session list has the session.
  const rootHint = new Map<string, string>();
  for (const e of input.events) {
    if (e.type === 'attention.opened') rootHint.set(e.payload.attention.sessionId, e.payload.attention.rootSessionId);
    else if (e.type === 'session.state_changed' || e.type === 'session.now_changed' || e.type === 'session.cost_updated')
      rootHint.set(e.payload.sessionId, e.payload.rootSessionId);
  }
  const rootOf = (id: string): string => session(id)?.rootSessionId ?? rootHint.get(id) ?? id;

  const items: TimelineItem[] = [];
  const lastMessage = new Map<string, string>();
  const scheduleMessage = new Map<string, string>();
  const attentionMoments = new Map<string, TimelineMoment>();
  const artifactAttention = new Set<string>();
  const pendingOutputs = new Map<string, TimelineOutput[]>();
  const lastFinished = new Map<string, TimelineMoment>();
  const runUnits = new Map<string, TimelineRun>();
  const toolSteps = new Map<string, TimelineStep>();
  const pendingWake = new Map<string, WakeItemView[]>();

  const target = (sessionId: string, messageId?: string | null): TimelineTarget => ({
    sessionId,
    messageId: messageId === undefined ? (lastMessage.get(sessionId) ?? null) : messageId,
  });

  const moment = (
    e: Event,
    sessionId: string,
    what: MomentKind,
    text: string,
    over: Partial<TimelineMoment> = {},
  ): TimelineMoment => {
    const m: TimelineMoment = {
      kind: 'moment',
      key: `m${e.seq}`,
      seq: e.seq,
      ts: e.ts,
      sessionId,
      rootId: rootOf(sessionId),
      what,
      attention: null,
      finishedAs: null,
      tone: 'neutral',
      text,
      outputs: [],
      resolution: null,
      open: false,
      target: target(sessionId),
      ...over,
    };
    items.push(m);
    return m;
  };

  const unitOf = (runId: string, e: Event): TimelineRun | null => {
    if (!details) return null;
    if (filters.runId && filters.runId !== runId) return null;
    const existing = runUnits.get(runId);
    if (existing) return existing;
    const run = input.runs.get(runId) ?? (e.type === 'run.created' ? e.payload.run : null);
    const sessionId = run?.sessionId ?? e.sessionId;
    if (!sessionId) return null;
    const unit: TimelineRun = {
      kind: 'run',
      key: `r${runId}`,
      seq: e.seq,
      ts: e.ts,
      runId,
      sessionId,
      rootId: rootOf(sessionId),
      run,
      trigger: run?.trigger ?? null,
      wake: run?.trigger === 'wake' ? (pendingWake.get(sessionId) ?? null) : null,
      headline: '',
      steps: [],
      state: runState(run),
      target: target(sessionId),
    };
    if (unit.wake) pendingWake.delete(sessionId);
    runUnits.set(runId, unit);
    items.push(unit);
    return unit;
  };

  const step = (unit: TimelineRun, e: Event, what: StepKind, text: string, isError = false): TimelineStep => {
    const s: TimelineStep = {
      key: `s${e.seq}`,
      seq: e.seq,
      ts: e.ts,
      what,
      text,
      isError,
      target: target(unit.sessionId),
    };
    unit.steps.push(s);
    return s;
  };

  const note = (e: Event, sessionId: string, what: NoteKind, text: string, tone: Tone = 'neutral') => {
    if (!details || filters.runId) return;
    items.push({
      kind: 'note',
      key: `n${e.seq}`,
      seq: e.seq,
      ts: e.ts,
      sessionId,
      rootId: rootOf(sessionId),
      what,
      text,
      tone,
      target: target(sessionId),
    });
  };

  const addOutput = (a: Artifact) => {
    if (a.role !== 'output' || !a.sessionId) return;
    const kind = outputKind(a);
    if (!kind) return;
    const out = { kind, title: a.title };
    // An output recorded right after its session finished still belongs to that moment.
    const fin = lastFinished.get(a.sessionId);
    if (fin && fin.outputs.length === 0) {
      fin.outputs.push(out);
      return;
    }
    pendingOutputs.set(a.sessionId, [...(pendingOutputs.get(a.sessionId) ?? []), out]);
  };

  for (const e of input.events) {
    switch (e.type) {
      case 'message.created': {
        const m = e.payload.message;
        if (m.role === 'user' && m.meta?.kind === 'brief') {
          moment(e, m.sessionId, 'brief', messageLine(m.meta.brief.goal) || messageLine(textOf(m)), {
            target: target(m.sessionId, m.id),
          });
        } else if (m.role === 'user' && m.meta?.kind === 'schedule') {
          scheduleMessage.set(m.sessionId, m.id);
        } else if (m.role === 'user' && m.author.kind === 'human' && m.meta?.kind !== 'answer') {
          moment(e, m.sessionId, 'request', messageLine(textOf(m)) || '（添付）', { target: target(m.sessionId, m.id) });
        } else if (m.role === 'system' && m.meta?.kind === 'wake') {
          pendingWake.set(m.sessionId, m.meta.items);
        }
        if (m.role !== 'tool') lastMessage.set(m.sessionId, m.id);
        if (m.role === 'assistant') {
          const runId = m.runId ?? e.runId;
          const unit = runId ? unitOf(runId, e) : null;
          const line = messageLine(textOf(m));
          if (unit && line) {
            step(unit, e, 'reply', line);
            unit.headline = line;
          }
        } else if (m.role === 'user' && m.author.kind === 'agent' && m.meta === null) {
          // A supervisor's follow-up to a child: a step of the supervisor's run.
          const unit = unitOf(m.author.runId, e);
          const title = session(m.sessionId);
          if (unit) step(unit, e, 'tool', `${title ? `「${shorten(sessionTitle(title), 30)}」へ` : ''}指示: ${messageLine(textOf(m), 60)}`);
        }
        break;
      }
      case 'attention.opened': {
        const a = e.payload.attention;
        const tone: Tone =
          a.kind === 'failure' ? 'failed' : a.kind === 'review' ? 'review' : 'needs_you';
        const m = moment(e, a.sessionId, 'attention', a.title, { attention: a.kind, tone, open: true });
        attentionMoments.set(a.id, m);
        if (a.refs.artifactId) artifactAttention.add(a.refs.artifactId);
        break;
      }
      case 'attention.resolved': {
        const a = e.payload.attention;
        const m = attentionMoments.get(a.id);
        if (!m) break;
        m.open = false;
        const r = a.resolution;
        if (a.status === 'dismissed') m.resolution = { label: '取り下げ', byHuman: true };
        else if (r && r.by.kind === 'human') {
          const choice = r.choiceId ? a.choices.find((c) => c.id === r.choiceId)?.label : null;
          m.resolution = { label: choice ?? (r.text ? `「${shorten(r.text, 24)}」` : '回答'), byHuman: true };
        } else m.resolution = { label: '解決', byHuman: false };
        break;
      }
      case 'session.state_changed': {
        const p = e.payload;
        if ((p.to === 'done' || p.to === 'review') && p.from !== p.to) {
          const outs = pendingOutputs.get(p.sessionId) ?? [];
          pendingOutputs.delete(p.sessionId);
          const m = moment(e, p.sessionId, 'finished', '', {
            finishedAs: p.to,
            tone: p.to === 'done' ? 'done' : 'review',
            outputs: outs,
          });
          lastFinished.set(p.sessionId, m);
        } else if (p.to === 'stopped' && p.parentSessionId === null) {
          moment(e, p.sessionId, 'stopped', '停止');
        } else if (p.to !== 'done' && p.to !== 'review') {
          // Working again: later outputs belong to the next finish.
          if (p.to === 'working') lastFinished.delete(p.sessionId);
        }
        break;
      }
      case 'artifact.created':
        addOutput(e.payload.artifact);
        break;
      case 'artifact.updated': {
        const a = e.payload.artifact;
        if (!e.payload.changes.includes('review') || a.review.by?.kind !== 'human' || !a.sessionId) break;
        if (artifactAttention.has(a.id)) break; // its review item shows the answer
        const kind = outputKind(a);
        if (a.review.state === 'accepted')
          moment(e, a.sessionId, 'accepted', a.title, { tone: 'done', outputs: kind ? [{ kind, title: a.title }] : [] });
        else if (a.review.state === 'rejected')
          moment(e, a.sessionId, 'redo', a.review.note ? shorten(a.review.note, 60) : a.title, {
            outputs: kind ? [{ kind, title: a.title }] : [],
          });
        break;
      }
      case 'schedule.fired': {
        const p = e.payload;
        const sid = p.sessionId ?? e.sessionId;
        if (!sid) break;
        const at = new Date(p.scheduledFor);
        const clock = `${at.getHours()}:${String(at.getMinutes()).padStart(2, '0')}`;
        // A started firing is told by its icon and the chip of the conversation it made.
        const text =
          p.outcome === 'started'
            ? ''
            : p.outcome === 'skipped_overlap'
              ? `${clock} の回を見送り`
              : p.outcome === 'missed'
                ? `${clock} の回を逃した`
                : `${clock} の回を開始できず`;
        moment(e, sid, 'schedule', text, {
          tone: p.outcome === 'failed_to_start' ? 'failed' : 'neutral',
          target: target(sid, scheduleMessage.get(sid) ?? null),
        });
        break;
      }
      case 'run.created': {
        unitOf(e.payload.run.id, e);
        break;
      }
      case 'tool.called': {
        const unit = unitOf(e.payload.runId, e);
        if (!unit) break;
        const s = step(unit, e, 'tool', stepPhrase(e.payload.name, e.payload.input));
        toolSteps.set(e.payload.toolCallId, s);
        break;
      }
      case 'tool.result': {
        const s = toolSteps.get(e.payload.toolCallId);
        if (s && e.payload.isError) {
          s.isError = true;
          const out = outputText(e.payload.output);
          if (out) s.text = `${s.text} · ${shorten(out, 80)}`;
        }
        break;
      }
      case 'run.failed': {
        const unit = unitOf(e.payload.run.id, e);
        if (unit) step(unit, e, 'failure', shorten(e.payload.error.message.split('\n')[0] ?? '', 100), true);
        break;
      }
      case 'inbox.added': {
        const item = e.payload.item;
        if (item.kind === 'user_message') break; // the request row says it
        const child = item.refs.childSessionId ? session(item.refs.childSessionId) : undefined;
        const text =
          item.kind === 'child_update' && child
            ? `「${shorten(sessionTitle(child), 30)}」の知らせ`
            : (INBOX_TEXT[item.kind] ?? '知らせ');
        note(e, item.sessionId, 'inbox', text);
        break;
      }
      case 'budget.threshold': {
        const sid = e.sessionId ?? e.payload.rootSessionId;
        if (sid) note(e, sid, 'budget', `予算の ${e.payload.pct}%`, e.payload.pct >= 100 ? 'failed' : e.payload.pct >= 80 ? 'needs_you' : 'neutral');
        break;
      }
      default:
        break;
    }
  }

  // Runs read their live status from the cache (a unit is built from its first event).
  for (const unit of runUnits.values()) {
    const live = input.runs.get(unit.runId);
    if (live) {
      unit.run = live;
      unit.state = runState(live);
      unit.trigger = live.trigger;
    }
    // No reply yet: what it is doing now (a live run), else its first step.
    if (!unit.headline)
      unit.headline =
        (unit.state === 'working' ? session(unit.sessionId)?.now : null) ??
        unit.steps.find((s) => s.what !== 'reply')?.text ??
        '';
    const lastStep = unit.steps[unit.steps.length - 1];
    unit.target = lastStep?.target ?? unit.target;
  }

  const q = filters.text.trim().toLowerCase();
  const titleOf = (id: string) => {
    const s = session(id);
    return s ? sessionTitle(s) : '';
  };
  const matches = (it: TimelineItem) => {
    if (filters.sessionId && it.sessionId !== filters.sessionId) return false;
    if (filters.runId && !(it.kind === 'run' && it.runId === filters.runId)) return false;
    if (!q) return true;
    const hay =
      it.kind === 'run'
        ? `${it.headline} ${it.steps.map((s) => s.text).join(' ')} ${(it.wake ?? []).map((w) => w.title).join(' ')}`
        : it.kind === 'moment'
          ? `${it.text} ${it.outputs.map((o) => o.title).join(' ')} ${it.resolution?.label ?? ''}`
          : it.text;
    return `${hay} ${titleOf(it.sessionId)}`.toLowerCase().includes(q);
  };

  const groups = new Map<string, TimelineGroup>();
  for (const it of items) {
    if (!matches(it)) continue;
    const g = groups.get(it.rootId) ?? { rootId: it.rootId, items: [], lastTs: it.ts };
    g.items.push(it);
    groups.set(it.rootId, g);
  }
  const out = [...groups.values()];
  for (const g of out) {
    g.items.sort((a, b) => a.seq - b.seq);
    const last = g.items[g.items.length - 1]!;
    g.lastTs = last.kind === 'run' && last.steps.length ? last.steps[last.steps.length - 1]!.ts : last.ts;
    for (const it of g.items) {
      const t = it.kind === 'run' && it.steps.length ? it.steps[it.steps.length - 1]!.ts : it.ts;
      if (t > g.lastTs) g.lastTs = t;
    }
  }
  return out.sort((a, b) => (a.lastTs < b.lastTs ? 1 : a.lastTs > b.lastTs ? -1 : 0));
}

/** Rows shown while a tree is folded: the newest few. */
export const FOLDED_ITEMS = 6;

/** The items of a group as shown (the newest `FOLDED_ITEMS` unless unfolded) and how many are hidden. */
export function visibleItems(g: TimelineGroup, unfolded: boolean): { items: TimelineItem[]; hidden: number } {
  if (unfolded || g.items.length <= FOLDED_ITEMS + 1) return { items: g.items, hidden: 0 };
  return { items: g.items.slice(-FOLDED_ITEMS), hidden: g.items.length - FOLDED_ITEMS };
}

const pad2 = (n: number) => String(n).padStart(2, '0');

/** Row time: `9:02` today, `昨日 9:02`, `10/27 9:02`. */
export function formatWhen(iso: string, now: number): string {
  const d = new Date(iso);
  const clock = `${d.getHours()}:${pad2(d.getMinutes())}`;
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  const t = d.getTime();
  if (t >= today.getTime()) return clock;
  if (t >= today.getTime() - 86_400_000) return `昨日 ${clock}`;
  return `${d.getMonth() + 1}/${d.getDate()} ${clock}`;
}

/** `42秒` `3分` `1時間12分` — how long a run took. */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '';
  if (ms < 60_000) return `${Math.max(1, Math.round(ms / 1000))}秒`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}分`;
  const h = Math.floor(ms / 3_600_000);
  const m = Math.round((ms % 3_600_000) / 60_000);
  return m ? `${h}時間${m}分` : `${h}時間`;
}
