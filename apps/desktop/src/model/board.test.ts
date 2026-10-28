import type { Integration } from '@acc/protocol';
import { describe, expect, it } from 'vitest';
import { T0, approval, id, iso, run, session, task } from '../test/fixtures';
import { attentionCounts, buildBoard, compareItems, groupByZone, nextAttention } from './board';

function scene() {
  const sRun = session({ title: '実行中' });
  const rRun = run(sRun, { startedAt: iso(T0 - 60_000) });
  sRun.activeRunId = rRun.id;

  const sApproveOld = session({ title: '承認 古い' });
  const rApproveOld = run(sApproveOld, { status: 'awaiting_approval' });
  const aOld = approval(rApproveOld, { createdAt: iso(T0 + 1_000) });

  const sApproveNew = session({ title: '承認 新しい' });
  const rApproveNew = run(sApproveNew, { status: 'awaiting_approval' });
  const aNew = approval(rApproveNew, { createdAt: iso(T0 + 5_000) });

  const sFailed = session({ title: '失敗' });
  const rFailed = run(sFailed, { status: 'failed', endedAt: iso(T0 - 1000) });

  const sInterrupted = session({ title: '中断' });
  const rInterrupted = run(sInterrupted, { status: 'interrupted', endedAt: iso(T0 - 2000) });

  const t = task({ status: 'review' });
  const sReview = session({ title: 'レビュー', taskId: t.id });
  const rReview = run(sReview, { status: 'completed', endedAt: iso(T0) });

  const sDone = session({ title: '完了' });
  const rDone = run(sDone, { status: 'completed', endedAt: iso(T0 - 10_000) });

  const sQueued = session({ title: '待機' });
  const rQueued = run(sQueued, { status: 'queued', startedAt: null });

  const sIdle = session({ title: '未実行', kind: 'chat' });

  return {
    sessions: [sRun, sApproveOld, sApproveNew, sFailed, sInterrupted, sReview, sDone, sQueued, sIdle],
    runs: [rRun, rApproveOld, rApproveNew, rFailed, rInterrupted, rReview, rDone, rQueued],
    approvals: [aNew, aOld],
    tasks: [t],
    integrations: [] as Integration[],
  };
}

describe('buildBoard', () => {
  it('puts attention first: approvals -> failed -> interrupted -> review, oldest first', () => {
    const items = buildBoard(scene());
    const titles = items.map((i) => i.title);
    expect(titles.slice(0, 5)).toEqual(['承認 古い', '承認 新しい', '失敗', '中断', 'レビュー']);
    const zones = groupByZone(items);
    expect(zones.running.map((i) => i.title)).toEqual(['実行中']);
    expect(zones.queued.map((i) => i.title)).toEqual(['待機']);
    expect(zones.done.map((i) => i.title)).toEqual(['完了']);
    expect(zones.idle.map((i) => i.title)).toEqual(['未実行']);
  });

  it('marks a run with a pending approval as awaiting approval even before the run status changes', () => {
    const sc = scene();
    const s = session({ title: 'x' });
    const r = run(s, { status: 'running' });
    const items = buildBoard({ ...sc, sessions: [s], runs: [r], approvals: [approval(r)] });
    expect(items[0]!.state).toBe('awaiting_approval');
    expect(items[0]!.zone).toBe('attention');
  });

  it('keeps a just-completed run in the running group for 1200ms (§3.2)', () => {
    const s = session({ title: 'just done' });
    const r = run(s, { status: 'completed', endedAt: iso(T0) });
    const base = { sessions: [s], runs: [r], approvals: [], tasks: [], integrations: [] };
    expect(buildBoard({ ...base, now: T0 + 500 })[0]!.zone).toBe('running');
    expect(buildBoard({ ...base, now: T0 + 1500 })[0]!.zone).toBe('done');
    expect(buildBoard(base)[0]!.zone).toBe('done');
  });

  it('filters by project and hides archived sessions', () => {
    const p = id('prj');
    const a = session({ projectId: p, title: 'in' });
    const b = session({ projectId: id('prj'), title: 'out' });
    const c = session({ projectId: p, title: 'archived', archivedAt: iso(T0) });
    const items = buildBoard({ sessions: [a, b, c], runs: [], approvals: [], tasks: [], integrations: [], projectId: p });
    expect(items.map((i) => i.title)).toEqual(['in']);
  });

  it('adds integrations awaiting review to attention', () => {
    const i: Integration = {
      id: id('int'),
      projectId: id('prj'),
      title: '統合候補',
      status: 'awaiting_approval',
      taskIds: [],
      branch: null,
      targetRef: null,
      workspaceId: null,
      steps: [],
      approvalId: null,
      error: null,
      createdBy: { kind: 'human' },
      createdAt: iso(T0),
      updatedAt: iso(T0),
    };
    const items = buildBoard({ sessions: [], runs: [], approvals: [], tasks: [], integrations: [i] });
    expect(items[0]).toMatchObject({ kind: 'integration', state: 'review', role: 'Integrator', zone: 'attention' });
  });

  it('sums session cost across runs with the combined cost source', () => {
    const s = session();
    const r1 = run(s, { usage: { inputTokens: 0, outputTokens: 0, costUsd: 0.25, costSource: 'reported' } });
    const r2 = run(s, { usage: { inputTokens: 0, outputTokens: 0, costUsd: 0.5, costSource: 'estimated' } });
    const [item] = buildBoard({ sessions: [s], runs: [r1, r2], approvals: [], tasks: [], integrations: [] });
    expect(item!.costUsd).toBeCloseTo(0.75);
    expect(item!.costSource).toBe('estimated');
  });
});

describe('attention navigation (Ctrl+J)', () => {
  it('cycles through attention items in priority order and wraps', () => {
    const items = buildBoard(scene());
    const first = nextAttention(items, null)!;
    expect(first.title).toBe('承認 古い');
    const second = nextAttention(items, first.id)!;
    expect(second.title).toBe('承認 新しい');
    const last = nextAttention(items, null, -1)!;
    expect(last.title).toBe('レビュー');
    expect(nextAttention(items, last.id)!.title).toBe('承認 古い');
  });

  it('returns null when nothing needs a human', () => {
    const s = session();
    expect(nextAttention(buildBoard({ sessions: [s], runs: [run(s)], approvals: [], tasks: [], integrations: [] }), null)).toBeNull();
  });

  it('counts attention by kind', () => {
    expect(attentionCounts(buildBoard(scene()))).toEqual({
      total: 5,
      awaiting_approval: 2,
      failed: 1,
      interrupted: 1,
      review: 1,
    });
  });

  it('compareItems is a stable total order', () => {
    const items = buildBoard(scene());
    const shuffled = [...items].reverse().sort(compareItems);
    expect(shuffled.map((i) => i.id)).toEqual(items.map((i) => i.id));
  });
});
