/**
 * Attention service and methods (spec 20261029 §1.6, §2.2): opening with dedupe, priority
 * order, resolving by refs, human.ask validation, listing scope and dismissing.
 */
import type { Approval, Attention } from '@acc/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { ApiError } from '../core/errors';
import { actorOf, insertRun } from '../policy/testutil';
import {
  HUMAN,
  SYSTEM,
  type TestDaemonNoServer,
  createTestDaemon,
  insertTestTask,
} from '../testing';
import { approvalAttentionTitle } from './approvals';
import { answerText } from './answer';
import { attentionPriority } from './priority';
import type { AttentionManager } from './service';
import { oneLine } from './text';

let d: TestDaemonNoServer | undefined;
afterEach(async () => {
  await d?.cleanup();
  d = undefined;
});

async function setup() {
  d = await createTestDaemon();
  const daemon = d;
  const att = d.ctx.service('attention') as AttentionManager;
  const session = await d.call(HUMAN, 'session.create', { title: '会話' });
  const open = (
    kind: Attention['kind'],
    refs: Attention['refs'],
    extra: Partial<Parameters<AttentionManager['open']>[0]> = {},
  ) => att.open({ kind, sessionId: session.id, title: `${kind}`, refs, actor: HUMAN, ...extra });
  const id = (kind: 'run' | 'task' | 'budget' | 'approval') => daemon.ctx.ids.next(kind);
  return { d: daemon, att, session, open, id };
}

async function codeOf(p: Promise<unknown>): Promise<string> {
  return p.then(
    () => 'ok',
    (e: unknown) => (e instanceof ApiError ? e.code : String(e)),
  );
}

describe('AttentionManager.open', () => {
  it('fills the kind defaults, one line, priority, and emits attention.opened', async () => {
    const s = await setup();
    const run = s.id('run');
    const a = s.open('failure', { runId: run }, { title: '「調査」が\n 失敗', detail: '  ' })!;
    expect(a).toMatchObject({
      kind: 'failure',
      status: 'open',
      sessionId: s.session.id,
      rootSessionId: s.session.id,
      title: '「調査」が 失敗',
      detail: null,
      choices: [
        { id: 'retry', label: '再試行', tone: 'primary' },
        { id: 'stop', label: '終える', tone: 'neutral' },
      ],
      allowText: true,
      refs: { runId: run },
      resolution: null,
      resolvedAt: null,
    });
    expect(a.priority).toBe(attentionPriority('failure', a.createdAt));
    const ev = s.d.ctx.bus.list({ types: ['attention.opened'] }).events;
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({ sessionId: s.session.id, runId: null, actor: HUMAN });
    expect(s.open('stuck', {}, { title: 'x'.repeat(200) })!.title).toHaveLength(80);
    expect(s.open('stuck', {}, { title: '   ' })).toBeNull();
    expect(
      s.d.ctx.service('attention').open({
        kind: 'stuck',
        sessionId: s.d.ctx.ids.next('session'),
        title: 'x',
        refs: {},
        actor: HUMAN,
      }),
    ).toBeNull();
  });

  it('dedupes by kind + session + refs; questions also by title; budgets without a budget app-wide', async () => {
    const s = await setup();
    const run = s.id('run');
    const a = s.open('failure', { runId: run })!;
    expect(s.open('failure', { runId: run })!.id).toBe(a.id);
    expect(s.open('stuck', { runId: run })!.id).not.toBe(a.id);
    expect(s.open('failure', { runId: run, taskId: s.id('task') })!.id).not.toBe(a.id);

    const q1 = s.open('question', { askedBySessionId: s.session.id, runId: run }, { title: 'A?' })!;
    const q2 = s.open('question', { askedBySessionId: s.session.id, runId: run }, { title: 'B?' })!;
    expect(q2.id).not.toBe(q1.id);
    expect(
      s.open('question', { askedBySessionId: s.session.id, runId: run }, { title: 'A?' })!.id,
    ).toBe(q1.id);

    const other = await s.d.call(HUMAN, 'session.create', { title: '別' });
    const daily = s.open('budget', {}, { title: '今日の上限に達しました' })!;
    const again = s.d.ctx.service('attention').open({
      kind: 'budget',
      sessionId: other.id,
      title: '今日の上限に達しました',
      refs: {},
      actor: SYSTEM,
    })!;
    expect(again.id).toBe(daily.id);
    const bud = s.id('budget');
    expect(s.open('budget', { budgetId: bud })!.id).not.toBe(daily.id);
    // Once resolved, the same cause may open a new item.
    s.att.resolveWhere({ runId: run }, { by: HUMAN });
    expect(s.open('failure', { runId: run })!.id).not.toBe(a.id);
  });
});

describe('resolving', () => {
  it('resolveWhere matches all given refs, never everything', async () => {
    const s = await setup();
    const [r1, r2, t1] = [s.id('run'), s.id('run'), s.id('task')];
    const a = s.open('failure', { runId: r1, taskId: t1 })!;
    const b = s.open('failure', { runId: r2, taskId: t1 })!;
    const c = s.open('stuck', { runId: r1 })!;
    expect(s.att.resolveWhere({}, { by: HUMAN })).toEqual([]);
    expect(s.att.resolveWhere({ runId: r1, taskId: t1 }, { by: HUMAN }).map((x) => x.id)).toEqual([
      a.id,
    ]);
    const resolved = s.att.resolveMatching({ taskId: t1 }, { choiceId: 'x', by: SYSTEM }, [
      'failure',
    ]);
    expect(resolved.map((x) => x.id)).toEqual([b.id]);
    expect(resolved[0]).toMatchObject({
      status: 'resolved',
      resolution: { choiceId: 'x', text: null, by: SYSTEM },
    });
    expect(s.d.ctx.repos.attention.require(c.id).status).toBe('open');
    expect(s.d.ctx.bus.list({ types: ['attention.resolved'] }).events).toHaveLength(2);
    expect(() => s.att.close(a.id, 'resolved', { by: HUMAN })).toThrow(
      expect.objectContaining({ code: 'conflict' }),
    );
  });

  it('a task moving on resolves its review / failure items', async () => {
    const s = await setup();
    const task = insertTestTask(s.d.ctx, { projectId: null, status: 'review' });
    const review = s.open('review', { taskId: task.id })!;
    const failure = s.open('failure', { taskId: task.id })!;
    const move = (status: 'review' | 'running' | 'done') =>
      s.d.ctx.db.transaction(() => {
        const next = s.d.ctx.repos.tasks.update(task.id, (t) => ({ ...t, status }));
        s.d.ctx.bus.emit({
          type: 'task.updated',
          actor: SYSTEM,
          payload: { task: next, changes: ['status'] },
        });
      });
    move('review');
    expect(s.d.ctx.repos.attention.require(review.id).status).toBe('open');
    move('running');
    expect(s.d.ctx.repos.attention.require(review.id).status).toBe('resolved');
    expect(s.d.ctx.repos.attention.require(failure.id)).toMatchObject({
      status: 'resolved',
      resolution: { by: SYSTEM },
    });
  });

  it('archiving a session resolves what was left on it', async () => {
    const s = await setup();
    const q = s.open('question', { askedBySessionId: s.session.id }, { title: 'どれ？' })!;
    await s.d.call(HUMAN, 'session.archive', { sessionId: s.session.id, archived: true });
    expect(s.d.ctx.repos.attention.require(q.id).status).toBe('resolved');
  });
});

describe('titles', () => {
  it('approval titles are noun phrases, also for approvals stored with a question title', async () => {
    const s = await setup();
    const base: Approval = {
      id: s.id('approval'),
      kind: 'tool_use',
      status: 'pending',
      title: 'コマンドの実行を承認しますか',
      detail: null,
      payload: { toolName: 'Bash', input: { command: 'pnpm add zod' }, risk: 'medium' },
      projectId: null,
      sessionId: s.session.id,
      runId: null,
      taskId: null,
      integrationId: null,
      requestedBy: HUMAN,
      resolvedBy: null,
      resolutionNote: null,
      createdAt: s.d.ctx.clock.iso(),
      resolvedAt: null,
    };
    expect(approvalAttentionTitle(s.d.ctx, base)).toBe('pnpm add zod を実行');
    expect(
      approvalAttentionTitle(s.d.ctx, {
        ...base,
        kind: 'integration',
        payload: null,
        title: '統合後のテストを実行',
      }),
    ).toBe('統合後のテストを実行');
    expect(
      approvalAttentionTitle(s.d.ctx, {
        ...base,
        kind: 'other',
        payload: null,
        title: '公開を承認しますか？',
      }),
    ).toBe('公開');
    expect(oneLine('a\n\nb   c')).toBe('a b c');
    expect(answerText({ id: 'c1', label: '載せる', tone: 'primary' }, '理由つき')).toBe(
      '回答: 載せる\n理由つき',
    );
    expect(answerText(null, '自由回答')).toBe('回答: 自由回答');
  });
});

describe('human.ask', () => {
  it('validates the question and keeps a long one whole in the detail', async () => {
    const s = await setup();
    s.d.ctx.service('policy').createGrant(
      {
        subject: { kind: 'session', sessionId: s.session.id },
        permissions: ['human.ask'],
        lifetime: 'session',
      },
      HUMAN,
    );
    const agent = actorOf(insertRun(s.d.ctx, { sessionId: s.session.id }));
    const ask = (p: Record<string, unknown>) => s.d.call(agent, 'human.ask', p as never);
    expect(await codeOf(s.d.call(HUMAN, 'human.ask', { question: 'x' }))).toBe('forbidden');
    expect(await codeOf(ask({ question: 'x', allowText: false }))).toBe('invalid_params');
    expect(await codeOf(ask({ question: 'x', choices: ['a', 'a'] }))).toBe('invalid_params');
    expect(await codeOf(ask({ question: 'x', choices: ['a', 'b', 'c', 'd', 'e'] }))).toBe(
      'invalid_params',
    );
    expect(await codeOf(ask({ question: '   ' }))).toBe('invalid_params');

    const long = `${'とても長い質問 '.repeat(15)}どうしますか？`;
    const r = await ask({
      question: long,
      detail: '背景です',
      allowText: false,
      choices: ['はい'],
    });
    expect(r.status).toBe('asked');
    const q = s.d.ctx.repos.attention.require(r.attentionId);
    expect(q.title.length).toBe(80);
    expect(q.detail).toBe(`${long.replace(/\s+/g, ' ').trim()}\n\n背景です`);
    expect(q).toMatchObject({
      allowText: false,
      choices: [{ id: 'c1', label: 'はい', tone: 'primary' }],
    });
    // Without the permission: forbidden.
    const other = await s.d.call(HUMAN, 'session.create', {});
    const stranger = actorOf(insertRun(s.d.ctx, { sessionId: other.id }));
    expect(await codeOf(s.d.call(stranger, 'human.ask', { question: 'x' }))).toBe('forbidden');
  });
});

describe('attention.list / attention.dismiss', () => {
  it('lists open items by priority (kind first, then oldest), filtered by status and tree', async () => {
    const s = await setup();
    const child = await s.d.call(HUMAN, 'session.create', { parentSessionId: s.session.id });
    const other = await s.d.call(HUMAN, 'session.create', {});
    const att = s.d.ctx.service('attention');
    const mk = (kind: Attention['kind'], sessionId: string) =>
      att.open({ kind, sessionId, title: kind, refs: { runId: s.id('run') }, actor: HUMAN })!;
    const review = mk('review', s.session.id);
    const failure1 = mk('failure', child.id);
    const approval = mk('approval', other.id);
    const failure2 = mk('failure', s.session.id);
    const question = mk('question', child.id);

    const all = await s.d.call(HUMAN, 'attention.list', {});
    expect(all.items.map((a) => a.id)).toEqual([
      approval.id,
      question.id,
      failure1.id,
      failure2.id,
      review.id,
    ]);
    const tree = await s.d.call(HUMAN, 'attention.list', { rootSessionId: s.session.id });
    expect(tree.items.map((a) => a.id)).toEqual([question.id, failure1.id, failure2.id, review.id]);
    const one = await s.d.call(HUMAN, 'attention.list', { sessionId: child.id, limit: 1 });
    expect(one.items.map((a) => a.id)).toEqual([question.id]);
    const page2 = await s.d.call(HUMAN, 'attention.list', {
      sessionId: child.id,
      limit: 1,
      cursor: one.nextCursor!,
    });
    expect(page2.items.map((a) => a.id)).toEqual([failure1.id]);

    // Dismiss: humans only; approvals must be answered.
    expect(await codeOf(s.d.call(HUMAN, 'attention.dismiss', { attentionId: approval.id }))).toBe(
      'conflict',
    );
    const dismissed = await s.d.call(HUMAN, 'attention.dismiss', { attentionId: review.id });
    expect(dismissed).toMatchObject({ status: 'dismissed', resolution: { by: HUMAN } });
    expect(
      (await s.d.call(HUMAN, 'attention.list', { status: ['dismissed'] })).items.map((a) => a.id),
    ).toEqual([review.id]);
    expect((await s.d.call(HUMAN, 'attention.list', {})).items).toHaveLength(4);
  });
});
