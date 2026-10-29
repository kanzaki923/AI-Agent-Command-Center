// @vitest-environment node
import type { Artifact, Event, Run, Session } from '@acc/protocol';
import { describe, expect, it } from 'vitest';
import { T0, attention, event, iso, message, run, session } from '../test/fixtures';
import {
  EMPTY_FILTERS,
  FOLDED_ITEMS,
  type TimelineGroup,
  type TimelineMoment,
  type TimelineRun,
  buildTimeline,
  formatDuration,
  formatWhen,
  messageLine,
  runState,
  stepPhrase,
  visibleItems,
} from './timeline';

const lead = session({ title: 'ローンチ準備', kind: 'chat' });
const faq = session({ title: 'FAQ を 10 問', parentSessionId: lead.id });
const press = session({ title: 'プレスリリース案', parentSessionId: lead.id });
const chat = session({ title: 'お詫びメール', kind: 'chat' });
const sessions = new Map<string, Session>([lead, faq, press, chat].map((s) => [s.id, s]));

const agentOf = (r: Run) => ({ kind: 'agent' as const, sessionId: r.sessionId, runId: r.id });
const SYSTEM = { kind: 'system' as const };

function doc(s: Session, title: string, over: Partial<Artifact> = {}): Artifact {
  return {
    id: `art_${title.length}${s.id.slice(-6)}`,
    kind: 'document',
    data: { format: 'markdown', content: '# x', path: null },
    projectId: null,
    sessionId: s.id,
    runId: null,
    taskId: null,
    workspaceId: null,
    title,
    createdBy: SYSTEM,
    createdAt: iso(T0),
    summary: null,
    review: { state: 'none', by: null, at: null, note: null },
    role: 'output',
    source: 'published',
    ...over,
  } as Artifact;
}

/** A small day: a request, two children asked, a question answered, a document finished. */
function scene() {
  const r1 = run(lead, { kind: 'orchestrator', trigger: 'user', status: 'completed' });
  const rf = run(faq, { trigger: 'spawn', status: 'completed' });
  const rp = run(press, { trigger: 'spawn', status: 'completed' });
  const wake = run(lead, { kind: 'orchestrator', trigger: 'wake', status: 'running', endedAt: null });
  const ask = message(lead, { content: [{ type: 'text', text: '来月の発売の準備を進めて\n詳しくは後で' }] });
  const briefF = message(faq, {
    author: agentOf(r1),
    meta: { kind: 'brief', brief: { goal: 'よくある質問を 10 問\n\n```acc-mock\n{"steps":[]}\n```', doneWhen: [], fromSessionId: lead.id, reviewBy: 'none', givenAt: iso(T0) } },
    content: [{ type: 'text', text: 'よくある質問を 10 問' }],
  });
  const faqSays = message(faq, { role: 'assistant', runId: rf.id, author: agentOf(rf), content: [{ type: 'text', text: '価格を載せてよいか確認します。' }] });
  const leadSays = message(lead, { role: 'assistant', runId: r1.id, author: agentOf(r1), content: [{ type: 'text', text: '2 人に任せました。' }] });
  const pressSays = message(press, { role: 'assistant', runId: rp.id, author: agentOf(rp), content: [{ type: 'text', text: '初稿を書きました。' }] });
  const q = attention(
    { id: faq.id, rootSessionId: lead.id },
    { title: '価格を FAQ に載せる？', choices: [{ id: 'c1', label: '載せる', tone: 'primary' }] },
  );
  const wakeMsg = message(lead, {
    role: 'system',
    author: SYSTEM,
    meta: { kind: 'wake', items: [{ sessionId: press.id, title: 'プレスリリース案', change: 'done', artifactIds: [] }] },
  });
  const pressDoc = doc(press, 'プレスリリース（案）');
  const events: Event[] = [
    event('message.created', { message: ask }, { sessionId: lead.id }),
    event('run.created', { run: r1 }, { sessionId: lead.id, runId: r1.id }),
    event('tool.called', { runId: r1.id, toolCallId: 'a', name: 'session.spawn', input: { title: 'FAQ を 10 問' } }, { runId: r1.id, sessionId: lead.id }),
    event('message.created', { message: briefF }, { sessionId: faq.id, actor: agentOf(r1) }),
    event('run.created', { run: rf }, { sessionId: faq.id, runId: rf.id }),
    event('message.created', { message: faqSays }, { sessionId: faq.id, runId: rf.id }),
    // Another run's events in between: the lead's run must stay one unit.
    event('tool.called', { runId: r1.id, toolCallId: 'b', name: 'mcp__acc__session_spawn', input: { title: 'プレスリリース案' } }, { runId: r1.id, sessionId: lead.id }),
    event('tool.result', { runId: r1.id, toolCallId: 'b', name: 'session.spawn', output: '上限です', isError: true, durationMs: 3 }, { runId: r1.id, sessionId: lead.id }),
    event('message.created', { message: leadSays }, { sessionId: lead.id, runId: r1.id }),
    event('attention.opened', { attention: q }, { sessionId: faq.id }),
    event('run.created', { run: rp }, { sessionId: press.id, runId: rp.id }),
    event('message.created', { message: pressSays }, { sessionId: press.id, runId: rp.id }),
    event('artifact.created', { artifact: pressDoc }, { sessionId: press.id, runId: rp.id }),
    event('session.state_changed', { sessionId: press.id, rootSessionId: lead.id, parentSessionId: lead.id, from: 'working', to: 'done', stateSince: iso(T0), now: null }, { sessionId: press.id }),
    event('inbox.added', { item: { id: 'inb_1', sessionId: lead.id, kind: 'child_update', refs: { childSessionId: press.id }, status: 'pending', consumedByRunId: null, createdAt: iso(T0) } }, { sessionId: lead.id }),
    event('message.created', { message: wakeMsg }, { sessionId: lead.id }),
    event('run.created', { run: wake }, { sessionId: lead.id, runId: wake.id }),
    event('attention.resolved', { attention: { ...q, status: 'resolved', resolution: { choiceId: 'c1', text: null, by: { kind: 'human' } } } }, { sessionId: faq.id }),
    event('budget.threshold', { budgetId: 'bud_1', rootSessionId: lead.id, pct: 80 }, { sessionId: lead.id }),
  ];
  const runs = new Map<string, Run>([r1, rf, rp, wake].map((r) => [r.id, r]));
  return { events, runs, r1, rf, rp, wake, ask, briefF, faqSays, pressSays, pressDoc };
}

const moments = (g: TimelineGroup | undefined) => (g?.items ?? []).filter((i): i is TimelineMoment => i.kind === 'moment');
const units = (g: TimelineGroup | undefined) => (g?.items ?? []).filter((i): i is TimelineRun => i.kind === 'run');

describe('timeline moments (spec §8)', () => {
  it('shows only the human moments by default, one group per tree', () => {
    const s = scene();
    const groups = buildTimeline({ events: s.events, sessions, runs: s.runs, details: false });
    expect(groups.map((g) => g.rootId)).toEqual([lead.id]);
    const ms = moments(groups[0]);
    expect(ms.map((m) => [m.what, m.sessionId])).toEqual([
      ['request', lead.id],
      ['brief', faq.id],
      ['attention', faq.id],
      ['finished', press.id],
    ]);
    expect(groups[0]!.items.every((i) => i.kind === 'moment')).toBe(true);
  });

  it('says each moment as one noun phrase, without plan blocks', () => {
    const s = scene();
    const [req, brief, q, fin] = moments(buildTimeline({ events: s.events, sessions, runs: s.runs, details: false })[0]);
    expect(req!.text).toBe('来月の発売の準備を進めて');
    expect(brief!.text).toBe('よくある質問を 10 問');
    expect(q).toMatchObject({ text: '価格を FAQ に載せる？', attention: 'question', tone: 'needs_you', open: false });
    expect(q!.resolution).toEqual({ label: '載せる', byHuman: true });
    expect(fin).toMatchObject({ finishedAs: 'done', tone: 'done', outputs: [{ kind: 'document', title: 'プレスリリース（案）' }] });
  });

  it('leads each row to its message (the request itself, the question’s message, the last reply)', () => {
    const s = scene();
    const [req, brief, q, fin] = moments(buildTimeline({ events: s.events, sessions, runs: s.runs, details: false })[0]);
    expect(req!.target).toEqual({ sessionId: lead.id, messageId: s.ask.id });
    expect(brief!.target).toEqual({ sessionId: faq.id, messageId: s.briefF.id });
    expect(q!.target).toEqual({ sessionId: faq.id, messageId: s.faqSays.id });
    expect(fin!.target).toEqual({ sessionId: press.id, messageId: s.pressSays.id });
  });

  it('keeps an open question open, and an item that settled by itself quiet', () => {
    const s = scene();
    const open = s.events.filter((e) => e.type !== 'attention.resolved');
    expect(moments(buildTimeline({ events: open, sessions, runs: s.runs, details: false })[0])[2]).toMatchObject({ open: true, resolution: null });
    const auto = s.events.map((e) =>
      e.type === 'attention.resolved'
        ? { ...e, payload: { attention: { ...e.payload.attention, resolution: { choiceId: null, text: null, by: SYSTEM } } } }
        : e,
    ) as Event[];
    expect(moments(buildTimeline({ events: auto, sessions, runs: s.runs, details: false })[0])[2]!.resolution).toEqual({ label: '解決', byHuman: false });
  });

  it('orders trees by their newest row and tells acceptance, redo and schedules', () => {
    const s = scene();
    const accepted = doc(press, 'プレスリリース（案）', { review: { state: 'accepted', by: { kind: 'human' }, at: iso(T0), note: null } });
    const redo = doc(press, '別案', { review: { state: 'rejected', by: { kind: 'human' }, at: iso(T0), note: '価格を入れて' } });
    const daily = session({ title: '朝のまとめ', kind: 'chat' });
    const fired = session({ title: '朝のまとめ · 10/30', parentSessionId: daily.id });
    const firstMsg = message(fired, { author: SYSTEM, meta: { kind: 'schedule', scheduleId: 'sch_1', scheduledFor: iso(T0) } });
    const more = [
      event('message.created', { message: message(chat, { content: [{ type: 'text', text: 'お詫びを書いて' }] }) }, { sessionId: chat.id }),
      event('artifact.updated', { artifact: accepted, changes: ['review'] }, { sessionId: press.id }),
      event('artifact.updated', { artifact: redo, changes: ['review'] }, { sessionId: press.id }),
      event('message.created', { message: firstMsg }, { sessionId: fired.id }),
      event('schedule.fired', { scheduleId: 'sch_1', sessionId: fired.id, scheduledFor: '2026-10-30T09:00:00+09:00', outcome: 'started' }, { sessionId: daily.id }),
    ];
    const all = new Map(sessions);
    all.set(daily.id, daily);
    all.set(fired.id, fired);
    const groups = buildTimeline({ events: [...s.events, ...more], sessions: all, runs: s.runs, details: false });
    expect(groups.map((g) => g.rootId)).toEqual([daily.id, lead.id, chat.id]);
    const sch = moments(groups[0])[0]!;
    expect(sch).toMatchObject({ what: 'schedule', sessionId: fired.id, target: { sessionId: fired.id, messageId: firstMsg.id } });
    expect(sch.text).toBe('');
    const tail = moments(groups[1]).slice(-2);
    expect(tail.map((m) => [m.what, m.text])).toEqual([
      ['accepted', 'プレスリリース（案）'],
      ['redo', '価格を入れて'],
    ]);
  });

  it('finds the tree of a session the list does not know from its creation event', () => {
    const late = session({ title: '新しい子', parentSessionId: lead.id });
    const ev = [
      event('session.created', { session: late }, { sessionId: late.id }),
      event('attention.opened', { attention: attention({ id: late.id, rootSessionId: lead.id }, { kind: 'failure', title: '失敗しました' }) }, { sessionId: late.id }),
    ];
    const groups = buildTimeline({ events: ev, sessions, runs: new Map(), details: false });
    expect(groups.map((g) => g.rootId)).toEqual([lead.id]);
    expect(moments(groups[0])[0]).toMatchObject({ tone: 'failed', attention: 'failure' });
  });
});

describe('timeline details', () => {
  it('shows each run as one unit even when other runs interleave (bug 9)', () => {
    const s = scene();
    const groups = buildTimeline({ events: s.events, sessions, runs: s.runs, details: true });
    const us = units(groups[0]);
    expect(us.map((u) => u.runId)).toEqual([s.r1.id, s.rf.id, s.rp.id, s.wake.id]);
    expect(new Set(us.map((u) => u.key)).size).toBe(us.length);
    const lead1 = us[0]!;
    expect(lead1.steps.map((x) => [x.what, x.text, x.isError])).toEqual([
      ['tool', '「FAQ を 10 問」に依頼', false],
      ['tool', '「プレスリリース案」に依頼 · 上限です', true],
      ['reply', '2 人に任せました', false],
    ]);
    expect(lead1).toMatchObject({ headline: '2 人に任せました', state: 'done', trigger: 'user' });
  });

  it('tells a wake by what changed, and adds the inbox and the budget', () => {
    const s = scene();
    const g = buildTimeline({ events: s.events, sessions, runs: s.runs, details: true })[0]!;
    const w = units(g).find((u) => u.runId === s.wake.id)!;
    expect(w.wake?.map((x) => [x.sessionId, x.change])).toEqual([[press.id, 'done']]);
    expect(w.state).toBe('working');
    const notes = g.items.filter((i) => i.kind === 'note');
    expect(notes.map((n) => (n.kind === 'note' ? [n.what, n.text, n.tone] : null))).toEqual([
      ['inbox', '「プレスリリース案」の知らせ', 'neutral'],
      ['budget', '予算の 80%', 'needs_you'],
    ]);
  });

  it('narrows to one conversation, one run (opened with its details) or a search', () => {
    const s = scene();
    const only = (filters: typeof EMPTY_FILTERS, details = false) =>
      buildTimeline({ events: s.events, sessions, runs: s.runs, details, filters }).flatMap((g) => g.items.map((i) => i.key));
    expect(only({ ...EMPTY_FILTERS, sessionId: faq.id })).toHaveLength(2);
    expect(only({ ...EMPTY_FILTERS, runId: s.r1.id })).toEqual([`r${s.r1.id}`]);
    expect(only({ ...EMPTY_FILTERS, text: 'プレス' })).toHaveLength(1);
    expect(only({ ...EMPTY_FILTERS, text: '上限' }, true)).toEqual([`r${s.r1.id}`]);
  });
});

describe('timeline helpers', () => {
  it('never shows a method name for the tree’s own tools', () => {
    expect(stepPhrase('mcp__acc__artifact_publish', { title: '今日のまとめ' })).toBe('成果物「今日のまとめ」を残す');
    expect(stepPhrase('human.ask', { question: '価格は？' })).toBe('質問: 価格は？');
    expect(stepPhrase('session.spawn', {})).toBe('子に依頼');
    expect(stepPhrase('mcp__acc__session_spawn', { title: 'FAQ' })).toBe('「FAQ」に依頼');
    expect(stepPhrase('Write', { file_path: '/w/notes/faq.md' })).toContain('faq.md');
  });

  it('maps run statuses onto the state icons', () => {
    const s = session();
    expect(runState(run(s, { status: 'running' }))).toBe('working');
    expect(runState(run(s, { status: 'awaiting_approval' }))).toBe('needs_you');
    expect(runState(run(s, { status: 'cancelled' }))).toBe('stopped');
    expect(runState(null)).toBe('idle');
  });

  it('folds a long tree to its newest rows', () => {
    const items = Array.from({ length: FOLDED_ITEMS + 4 }, (_, i) => ({ kind: 'note', key: `n${i}` }) as never);
    const g = { rootId: 'x', items, lastTs: iso(T0) };
    expect(visibleItems(g, false)).toMatchObject({ hidden: 4 });
    expect(visibleItems(g, false).items[0]).toMatchObject({ key: 'n4' });
    expect(visibleItems(g, true).hidden).toBe(0);
    // One hidden row is not worth a "前の 1 件" line.
    expect(visibleItems({ ...g, items: items.slice(0, FOLDED_ITEMS + 1) }, false).hidden).toBe(0);
  });

  it('formats times and durations', () => {
    const now = new Date(2026, 9, 30, 15, 0).getTime();
    expect(formatWhen(new Date(2026, 9, 30, 9, 5).toISOString(), now)).toBe('9:05');
    expect(formatWhen(new Date(2026, 9, 29, 23, 0).toISOString(), now)).toBe('昨日 23:00');
    expect(formatWhen(new Date(2026, 9, 20, 8, 0).toISOString(), now)).toBe('10/20 8:00');
    expect(formatDuration(42_000)).toBe('42秒');
    expect(formatDuration(3 * 60_000)).toBe('3分');
    expect(formatDuration(72 * 60_000)).toBe('1時間12分');
    expect(messageLine('```x\ny\n```\n\n本文です')).toBe('本文です');
    expect(messageLine('# リモートワークの **1 年**\n本文')).toBe('リモートワークの 1 年');
    expect(messageLine('- 項目')).toBe('項目');
  });
});

describe('a live run with nothing said yet', () => {
  it('reads as what its conversation is doing now', () => {
    const blog = session({ title: 'ブログ', kind: 'chat', now: '回答を作成中' });
    const r = run(blog, { status: 'running' });
    const groups = buildTimeline({
      events: [event('run.created', { run: r }, { sessionId: blog.id, runId: r.id })],
      sessions: new Map([[blog.id, blog]]),
      runs: new Map([[r.id, r]]),
      details: true,
    });
    expect(units(groups[0])[0]).toMatchObject({ headline: '回答を作成中', state: 'working', steps: [] });
  });
});
