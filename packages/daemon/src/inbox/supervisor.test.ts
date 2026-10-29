/**
 * Acceptance tests of T1 Supervisor (spec 20261029 §5.3): inbox, wakes, stop / resume,
 * runaway protection, restart, the mock supervisor and the two slot pools. Real daemon, mock
 * models, a held agent executor for the children; session.spawn / session.tree come from
 * inbox/testkit.ts until T2 / T7 implement them.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Message, Run, Session } from '@acc/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createManualClock } from '../core/clock';
import type { ChatRequest } from '../llm/types';
import { DEMO_GOAL_HINT } from '../orchestrator/demo';
import { MOCK_ORCHESTRATOR_MODEL } from '../orchestrator/mockModel';
import { ACTIVE_RUN_STATUSES } from '../runs/manager';
import { HUMAN, SYSTEM, type TestDaemonNoServer, createTestDaemon } from '../testing';
import {
  type ChildAgents,
  installChildAgents,
  installTestSpawn,
  installTestTree,
  setSupervisorLimits,
} from './testkit';
import { INJECTED_PREFIX, WAKE_MARKER } from './wake';

vi.setConfig({ testTimeout: 30_000 });

const GOAL = '新製品のローンチ準備を進めて。競合の価格調査、FAQ、告知文をお願い';
const DEBOUNCE_MS = 150;

const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn();
});

async function until<T>(fn: () => T | undefined | null | false, timeoutMs = 10_000): Promise<T> {
  const started = Date.now();
  for (;;) {
    const v = fn();
    if (v !== undefined && v !== null && v !== false) return v;
    if (Date.now() - started > timeoutMs) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 10));
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Scene {
  d: TestDaemonNoServer;
  lead: Session;
  agents: ChildAgents;
}

/** A daemon with the test stand-ins and a delegated chat (the supervisor) on mock/orchestrator. */
async function prepare(d: TestDaemonNoServer): Promise<ChildAgents> {
  d.ctx.service('llm').mock.chunkDelayMs = 0;
  setSupervisorLimits(d.ctx, { wakeDebounceMs: DEBOUNCE_MS });
  installTestSpawn(d.ctx);
  installTestTree(d.ctx);
  return installChildAgents(d.ctx);
}

async function scene(
  opts: { model?: string; clock?: ReturnType<typeof createManualClock> } = {},
): Promise<Scene> {
  const d = await createTestDaemon(opts.clock ? { clock: opts.clock } : {});
  cleanups.push(() => d.cleanup());
  const agents = await prepare(d);
  const lead = await d.call(HUMAN, 'session.create', {
    kind: 'chat',
    title: '指揮役',
    model: opts.model ?? MOCK_ORCHESTRATOR_MODEL,
  });
  await d.call(HUMAN, 'session.delegate', { sessionId: lead.id });
  return { d, lead, agents };
}

const runsOf = (d: TestDaemonNoServer, sessionId: string): Run[] =>
  d.ctx.repos.runs.find({ where: { session_id: sessionId }, direction: 'asc' });
const childrenOf = (d: TestDaemonNoServer, sessionId: string): Session[] =>
  d.ctx.repos.sessions.find({ where: { parent_session_id: sessionId }, direction: 'asc' });
const activeRuns = (d: TestDaemonNoServer, sessionId: string) =>
  d.ctx.repos.runs.count({ where: { session_id: sessionId, status: [...ACTIVE_RUN_STATUSES] } });
const messagesOf = (d: TestDaemonNoServer, sessionId: string): Message[] =>
  d.ctx.repos.messages.find({ where: { session_id: sessionId }, direction: 'asc' });
const textOf = (m: Message) =>
  m.content
    .filter((p) => p.type === 'text')
    .map((p) => p.text)
    .join('\n');
const assistantTexts = (d: TestDaemonNoServer, sessionId: string) =>
  messagesOf(d, sessionId)
    .filter((m) => m.role === 'assistant')
    .map(textOf)
    .filter(Boolean);
const wakeRuns = (d: TestDaemonNoServer, sessionId: string) =>
  runsOf(d, sessionId).filter((r) => r.trigger === 'wake');

/** Send the goal; resolves once the supervisor's first run ended and the 3 children are held. */
async function delegateGoal(s: Scene): Promise<{ run: Run; children: Session[] }> {
  const sent = await s.d.call(HUMAN, 'session.send', { sessionId: s.lead.id, content: GOAL });
  expect(sent.delivery).toBe('started');
  const run = await s.d.ctx.service('runs').waitForEnd(sent.runId!);
  const children = childrenOf(s.d, s.lead.id);
  await until(() => s.agents.held().length === children.length);
  return { run, children };
}

/** Wait until the supervisor has `n` wake runs and none is active, then a bit past the debounce. */
async function settleWakes(s: Scene, n: number): Promise<void> {
  await until(() => wakeRuns(s.d, s.lead.id).length >= n && activeRuns(s.d, s.lead.id) === 0);
  await sleep(DEBOUNCE_MS * 2);
}

describe('T1 supervisor: event-driven runs', () => {
  it('1. a goal starts 3 children and the supervisor run completes; it has no run while they work', async () => {
    const s = await scene();
    const { run, children } = await delegateGoal(s);
    expect(run).toMatchObject({ kind: 'orchestrator', status: 'completed', trigger: 'user' });
    expect(children.map((c) => c.title)).toEqual([
      '競合の価格を調べる',
      'FAQ を書く',
      '告知文を書く',
    ]);
    expect(children.every((c) => c.kind === 'agent' && c.rootSessionId === s.lead.id)).toBe(true);
    expect(s.agents.held()).toHaveLength(3);
    expect(activeRuns(s.d, s.lead.id)).toBe(0);
    expect(assistantTexts(s.d, s.lead.id).at(-1)).toContain('3 人に任せました');
  });

  it('2. "いま何してる？" while children work starts a run that answers with session.tree', async () => {
    const s = await scene();
    await delegateGoal(s);
    const sent = await s.d.call(HUMAN, 'session.send', {
      sessionId: s.lead.id,
      content: 'いま何してる？',
    });
    expect(sent.delivery).toBe('started');
    const run = await s.d.ctx.service('runs').waitForEnd(sent.runId!);
    expect(run.status).toBe('completed');
    const called = s.d.ctx.bus
      .list({ runId: run.id, types: ['tool.called'] })
      .events.map((e) => (e.type === 'tool.called' ? e.payload.name : ''));
    expect(called).toEqual(['session.tree']);
    expect(assistantTexts(s.d, s.lead.id).at(-1)).toContain('0/3 件が終わりました');
  });

  it('3. a message sent while the supervisor runs is injected into the next model call of that run', async () => {
    const requests: ChatRequest[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const s = await scene({ model: 'mock/t1-inject' });
    s.d.ctx.service('llm').mock.define('mock/t1-inject', async (req) => {
      requests.push({ ...req, messages: [...req.messages] });
      if (requests.length === 1) {
        await gate;
        return {
          text: '会話を確かめます。',
          toolCalls: [{ name: 'session__get', input: { sessionId: s.lead.id } }],
        };
      }
      return { text: '受け取りました。' };
    });
    const first = await s.d.call(HUMAN, 'session.send', { sessionId: s.lead.id, content: '最初' });
    await until(() => requests.length === 1);
    const second = await s.d.call(HUMAN, 'session.send', {
      sessionId: s.lead.id,
      content: '追加の指示',
    });
    expect(second).toMatchObject({ delivery: 'injected', runId: first.runId });
    expect(s.d.ctx.repos.messages.require(second.messageId).delivery).toBe('queued');
    release();
    const run = await s.d.ctx.service('runs').waitForEnd(first.runId!);
    expect(run.status).toBe('completed');
    expect(requests).toHaveLength(2);
    const injected = requests[1]!.messages.at(-1)!;
    expect(injected).toMatchObject({ role: 'user' });
    expect(injected.content).toBe(`${INJECTED_PREFIX}\n追加の指示`);
    expect(s.d.ctx.repos.messages.require(second.messageId).delivery).toBe('delivered');
    expect(runsOf(s.d, s.lead.id)).toHaveLength(1);
    const updated = s.d.ctx.bus.list({ types: ['message.updated'] }).events;
    expect(
      updated.some(
        (e) => e.type === 'message.updated' && e.payload.message.id === second.messageId,
      ),
    ).toBe(true);
  });

  it('4. two children finishing within the debounce wake the supervisor once, with both in meta.wake', async () => {
    const s = await scene();
    const { children } = await delegateGoal(s);
    s.agents.finish(children[0]!.id);
    s.agents.finish(children[1]!.id);
    await settleWakes(s, 1);
    const wakes = wakeRuns(s.d, s.lead.id);
    expect(wakes).toHaveLength(1);
    expect(wakes[0]!.status).toBe('completed');
    const wake = s.d.ctx.repos.messages.require(wakes[0]!.triggerMessageId!);
    expect(wake.role).toBe('system');
    expect(textOf(wake).startsWith(WAKE_MARKER)).toBe(true);
    expect(wake.meta).toMatchObject({
      kind: 'wake',
      items: [
        { sessionId: children[0]!.id, change: 'done' },
        { sessionId: children[1]!.id, change: 'done' },
      ],
    });
    expect(assistantTexts(s.d, s.lead.id).at(-1)).toContain('2/3 件が終わりました');
    // The items are consumed by that run (audit trail).
    const consumed = s.d.ctx.bus.list({ types: ['inbox.consumed'] }).events;
    expect(
      consumed.some((e) => e.type === 'inbox.consumed' && e.payload.runId === wakes[0]!.id),
    ).toBe(true);

    s.agents.finish(children[2]!.id);
    await settleWakes(s, 2);
    expect(assistantTexts(s.d, s.lead.id).at(-1)).toContain('すべての作業が終わりました');
  });

  it('5. session.stop stops the whole tree (runs cancelled, tasks paused, no wakes); resume restarts it', async () => {
    const s = await scene();
    const { children } = await delegateGoal(s);
    const childRuns = children.map((c) => runsOf(s.d, c.id)[0]!.id);
    const stopped = await s.d.call(HUMAN, 'session.stop', { sessionId: s.lead.id });
    expect(stopped.stoppedSessionIds.sort()).toEqual(
      [s.lead.id, ...children.map((c) => c.id)].sort(),
    );
    expect(stopped.cancelledRunIds.sort()).toEqual([...childRuns].sort());
    for (const id of childRuns) {
      expect(await s.d.ctx.service('runs').waitForEnd(id)).toMatchObject({
        status: 'cancelled',
        statusReason: 'stopped_by_user',
      });
    }
    for (const c of children) {
      expect(s.d.ctx.repos.tasks.findOne({ where: { assignee_session_id: c.id } })?.status).toBe(
        'paused',
      );
      expect(s.d.ctx.repos.sessions.require(c.id).supervision).toBe('paused');
    }
    await sleep(DEBOUNCE_MS * 3);
    expect(wakeRuns(s.d, s.lead.id)).toHaveLength(0);
    expect(runsOf(s.d, s.lead.id)).toHaveLength(1);

    const resumed = await s.d.call(HUMAN, 'session.resume', { sessionId: s.lead.id });
    expect(resumed.resumedSessionIds.sort()).toEqual(stopped.stoppedSessionIds.sort());
    expect(resumed.runIds).toHaveLength(3);
    for (const id of resumed.runIds) {
      expect(s.d.ctx.repos.runs.require(id)).toMatchObject({ kind: 'agent', trigger: 'resume' });
    }
    expect(s.d.ctx.repos.sessions.require(s.lead.id).supervision).toBe('active');
    await until(() => s.agents.held().length === 3);
    for (const c of children) {
      expect(s.d.ctx.repos.tasks.findOne({ where: { assignee_session_id: c.id } })?.status).toBe(
        'running',
      );
    }
    s.agents.finishAll();
    await settleWakes(s, 1);
    expect(assistantTexts(s.d, s.lead.id).at(-1)).toContain('すべての作業が終わりました');
  });

  it('5b. a human stopping one child wakes the parent; the parent stopping its own child does not', async () => {
    const s = await scene();
    const { children } = await delegateGoal(s);
    await s.d.call(HUMAN, 'session.stop', { sessionId: children[0]!.id });
    await settleWakes(s, 1);
    const wake = s.d.ctx.repos.messages.require(wakeRuns(s.d, s.lead.id)[0]!.triggerMessageId!);
    expect(wake.meta).toMatchObject({
      kind: 'wake',
      items: [{ sessionId: children[0]!.id, change: 'stopped' }],
    });
    // "止めて" to the supervisor: it stops the others itself and is not woken for that.
    const sent = await s.d.call(HUMAN, 'session.send', { sessionId: s.lead.id, content: '止めて' });
    const run = await s.d.ctx.service('runs').waitForEnd(sent.runId!);
    expect(run.status).toBe('completed');
    const stops = s.d.ctx.bus
      .list({ runId: run.id, types: ['tool.result'] })
      .events.filter((e) => e.type === 'tool.result' && e.payload.name === 'session.stop');
    expect(stops).toHaveLength(2);
    await sleep(DEBOUNCE_MS * 3);
    expect(wakeRuns(s.d, s.lead.id)).toHaveLength(1);
  });
});

describe('T1 supervisor: delivery to agents', () => {
  it('6. a message to a busy agent is queued for after its run; interrupt supersedes the run', async () => {
    const d = await createTestDaemon();
    cleanups.push(() => d.cleanup());
    const agents = await prepare(d);
    const s = await d.call(HUMAN, 'session.create', { kind: 'agent', title: 'エージェント' });
    const first = await d.call(HUMAN, 'session.send', { sessionId: s.id, content: '作業1' });
    expect(first.delivery).toBe('started');
    await until(() => agents.held().length === 1);
    const queued = await d.call(HUMAN, 'session.send', { sessionId: s.id, content: '作業2' });
    expect(queued).toMatchObject({ delivery: 'queued', runId: null });
    expect(d.ctx.repos.messages.require(queued.messageId).delivery).toBe('queued');

    agents.finish(s.id);
    const second = await until(() => runsOf(d, s.id)[1]);
    expect(second).toMatchObject({ triggerMessageId: queued.messageId, trigger: 'user' });
    expect(d.ctx.repos.messages.require(queued.messageId).delivery).toBe('delivered');
    await until(() => agents.held().length === 1);

    const now = await d.call(HUMAN, 'session.send', {
      sessionId: s.id,
      content: '今すぐこっち',
      interrupt: true,
    });
    expect(now.delivery).toBe('started');
    expect(await d.ctx.service('runs').waitForEnd(second.id)).toMatchObject({
      status: 'cancelled',
      statusReason: 'superseded',
    });
    expect(d.ctx.repos.runs.require(now.runId!)).toMatchObject({
      triggerMessageId: now.messageId,
    });
    await until(() => agents.held().length === 1);
    agents.finish(s.id);
    expect(await d.ctx.service('runs').waitForEnd(now.runId!)).toMatchObject({
      status: 'completed',
    });
  });
});

describe('T1 supervisor: restart', () => {
  it('7. after a restart the children resume once and the supervisor (default grant) is woken as they finish', async () => {
    const home = mkdtempSync(join(tmpdir(), 'acc-t1-'));
    cleanups.push(() => rmSync(home, { recursive: true, force: true, maxRetries: 5 }));
    const d1 = await createTestDaemon({ home });
    const lead = await d1.call(HUMAN, 'session.create', {
      kind: 'chat',
      title: '指揮役',
      model: MOCK_ORCHESTRATOR_MODEL,
    });
    await d1.call(HUMAN, 'session.delegate', { sessionId: lead.id });
    const { children } = await delegateGoal({ d: d1, lead, agents: await prepare(d1) });
    await d1.close();

    // The test executor is registered right after start, before the restart resume runs.
    const d2 = await createTestDaemon({ home });
    const agents2 = await prepare(d2);
    await until(() => agents2.held().length === 3);
    expect(agents2.started).toHaveLength(3);
    for (const r of agents2.started) {
      expect(r).toMatchObject({ kind: 'agent', trigger: 'resume' });
      expect(d2.ctx.repos.messages.require(r.triggerMessageId!).role).toBe('user');
    }
    expect(new Set(agents2.started.map((r) => r.sessionId))).toEqual(
      new Set(children.map((c) => c.id)),
    );
    expect(d2.ctx.service('policy').sessionAllows(lead.id, 'session.spawn')).toBe(true);
    agents2.finish(children[0]!.id);
    agents2.finish(children[1]!.id);
    await settleWakes({ d: d2, lead, agents: agents2 }, 1);
    expect(assistantTexts(d2, lead.id).at(-1)).toContain('2/3 件が終わりました');

    // The third child is cut off again while resuming: it is not resumed a second time.
    await d2.close();
    const d3 = await createTestDaemon({ home });
    cleanups.push(() => d3.close());
    const agents3 = await prepare(d3);
    await sleep(100);
    expect(agents3.started).toHaveLength(0);
    expect(runsOf(d3, children[2]!.id).at(-1)).toMatchObject({
      status: 'interrupted',
      trigger: 'resume',
    });
  });

  it('7b. a supervisor cut off mid-run is woken with a resume update', async () => {
    const home = mkdtempSync(join(tmpdir(), 'acc-t1-'));
    cleanups.push(() => rmSync(home, { recursive: true, force: true, maxRetries: 5 }));
    const d1 = await createTestDaemon({ home });
    await prepare(d1);
    let calls = 0;
    d1.ctx.service('llm').mock.define('mock/t1-slow', async (_req, _info) => {
      calls += 1;
      return new Promise<never>(() => undefined);
    });
    const lead = await d1.call(HUMAN, 'session.create', {
      kind: 'chat',
      title: '指揮役',
      model: 'mock/t1-slow',
    });
    await d1.call(HUMAN, 'session.delegate', { sessionId: lead.id });
    const sent = await d1.call(HUMAN, 'session.send', { sessionId: lead.id, content: '計画して' });
    await until(() => calls === 1);
    await d1.close();

    const d2 = await createTestDaemon({ home });
    cleanups.push(() => d2.close());
    await prepare(d2);
    d2.ctx.service('llm').mock.define('mock/t1-slow', () => ({ text: '続きから進めます。' }));
    const wake = await until(() => wakeRuns(d2, lead.id)[0]);
    expect(await d2.ctx.service('runs').waitForEnd(wake.id)).toMatchObject({ status: 'completed' });
    const msg = d2.ctx.repos.messages.require(wake.triggerMessageId!);
    expect(msg.meta).toMatchObject({
      kind: 'wake',
      items: [{ sessionId: lead.id, change: 'resume' }],
    });
    expect(textOf(msg)).toContain(sent.runId!);
    // Once per interrupted run.
    await d2.close();
    const d3 = await createTestDaemon({ home });
    cleanups.push(() => d3.close());
    await prepare(d3);
    await sleep(DEBOUNCE_MS * 3);
    expect(wakeRuns(d3, lead.id)).toHaveLength(1);
  });
});

describe('T1 supervisor: runaway protection', () => {
  it('8. the same tool call three times in a row fails with loop_detected, opens stuck and pauses waking', async () => {
    const s = await scene({ model: 'mock/t1-loop' });
    s.d.ctx.service('llm').mock.define('mock/t1-loop', () => ({
      text: '',
      toolCalls: [{ name: 'session__get', input: { sessionId: s.lead.id } }],
    }));
    const open = vi.spyOn(s.d.ctx.service('attention'), 'open');
    const sent = await s.d.call(HUMAN, 'session.send', { sessionId: s.lead.id, content: '調べて' });
    const run = await s.d.ctx.service('runs').waitForEnd(sent.runId!);
    expect(run).toMatchObject({ status: 'failed', statusReason: 'loop_detected' });
    expect(run.error?.code).toBe('loop_detected');
    expect(open).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'stuck', sessionId: s.lead.id, refs: { runId: run.id } }),
    );
    expect(s.d.ctx.repos.sessions.require(s.lead.id).supervision).toBe('paused');
    // Updates keep arriving but do not wake it.
    s.d.ctx.service('inbox').deliver(s.lead.id, { kind: 'budget', actor: SYSTEM });
    await sleep(DEBOUNCE_MS * 3);
    expect(runsOf(s.d, s.lead.id)).toHaveLength(1);
  });

  it('8b. more model calls than maxModelCallsPerRun fail the run with turn_limit', async () => {
    const s = await scene({ model: 'mock/t1-busy' });
    setSupervisorLimits(s.d.ctx, { maxModelCallsPerRun: 3 });
    let n = 0;
    s.d.ctx.service('llm').mock.define('mock/t1-busy', () => {
      n += 1;
      return {
        text: `手順 ${n}`,
        toolCalls: [
          n % 2 === 0
            ? { name: 'session__get', input: { sessionId: s.lead.id } }
            : { name: 'session__messages', input: { sessionId: s.lead.id } },
        ],
      };
    });
    const sent = await s.d.call(HUMAN, 'session.send', { sessionId: s.lead.id, content: '調べて' });
    const run = await s.d.ctx.service('runs').waitForEnd(sent.runId!);
    expect(run).toMatchObject({ status: 'failed', statusReason: 'turn_limit' });
    expect(n).toBe(3);
  });

  it('9. more wakes per hour than allowed (without a human message) pause supervision and open stuck', async () => {
    const clock = createManualClock(Date.UTC(2026, 9, 29, 9));
    const s = await scene({ model: 'mock/fast', clock });
    setSupervisorLimits(s.d.ctx, { maxWakesPerHour: 2, wakeDebounceMs: 20 });
    const open = vi.spyOn(s.d.ctx.service('attention'), 'open');
    const poke = async (n: number) => {
      s.d.ctx.service('inbox').deliver(s.lead.id, { kind: 'budget', actor: SYSTEM });
      await until(() => wakeRuns(s.d, s.lead.id).length >= n && activeRuns(s.d, s.lead.id) === 0);
      clock.advance(60_000);
    };
    await poke(1);
    await poke(2);
    s.d.ctx.service('inbox').deliver(s.lead.id, { kind: 'budget', actor: SYSTEM });
    await until(() => s.d.ctx.repos.sessions.require(s.lead.id).supervision === 'paused');
    expect(wakeRuns(s.d, s.lead.id)).toHaveLength(2);
    expect(open).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'stuck', sessionId: s.lead.id }),
    );

    // A person writing takes it back; the count starts again from that message, so what
    // waited meanwhile wakes it after the reply.
    clock.advance(60_000);
    const sent = await s.d.call(HUMAN, 'session.send', { sessionId: s.lead.id, content: '続けて' });
    await s.d.ctx.service('runs').waitForEnd(sent.runId!);
    expect(s.d.ctx.repos.sessions.require(s.lead.id).supervision).toBe('active');
    await until(() => wakeRuns(s.d, s.lead.id).length === 3 && activeRuns(s.d, s.lead.id) === 0);
    expect(wakeRuns(s.d, s.lead.id).every((r) => r.status === 'completed')).toBe(true);
  });

  it('a transient supervisor failure is retried later through a resume item', async () => {
    const s = await scene({ model: 'mock/t1-flaky' });
    s.d.ctx.service('supervisorInbox').retryDelaysMs = [30, 30, 30];
    let n = 0;
    s.d.ctx.service('llm').mock.define('mock/t1-flaky', () => {
      n += 1;
      return n === 1 ? { error: 'connection reset' } : { text: '続けます。' };
    });
    const sent = await s.d.call(HUMAN, 'session.send', {
      sessionId: s.lead.id,
      content: '計画して',
    });
    expect(await s.d.ctx.service('runs').waitForEnd(sent.runId!)).toMatchObject({
      status: 'failed',
    });
    const wake = await until(() => wakeRuns(s.d, s.lead.id)[0]);
    expect(await s.d.ctx.service('runs').waitForEnd(wake.id)).toMatchObject({
      status: 'completed',
    });
    expect(s.d.ctx.repos.messages.require(wake.triggerMessageId!).meta).toMatchObject({
      kind: 'wake',
      items: [{ change: 'resume' }],
    });
  });
});

describe('T1 supervisor: mock demo and slots', () => {
  it('10. the demo stops at its final report: once, few supervisor runs, no repeated text', async () => {
    const d = await createTestDaemon();
    cleanups.push(() => d.cleanup());
    const agents = await prepare(d);
    const demo = await d.call(HUMAN, 'system.setupDemo', {});
    const lead = demo.session;
    const s: Scene = { d, lead, agents };
    const sent = await d.call(HUMAN, 'session.send', {
      sessionId: lead.id,
      content: DEMO_GOAL_HINT,
    });
    expect(await d.ctx.service('runs').waitForEnd(sent.runId!)).toMatchObject({
      status: 'completed',
    });
    const children = childrenOf(d, lead.id);
    expect(children).toHaveLength(3);
    await until(() => agents.held().length === 3);
    for (const [i, c] of children.entries()) {
      agents.finish(c.id);
      await settleWakes(s, i + 1);
    }
    const texts = assistantTexts(d, lead.id);
    expect(texts.filter((t) => t.startsWith('すべての作業が終わりました'))).toHaveLength(1);
    expect(texts.at(-1)).toContain('すべての作業が終わりました');
    const supervisorRuns = runsOf(d, lead.id);
    expect(supervisorRuns.length).toBeLessThanOrEqual(children.length + 2);
    expect(supervisorRuns.every((r) => r.status === 'completed')).toBe(true);
    for (let i = 1; i < texts.length; i++) expect(texts[i]).not.toBe(texts[i - 1]);
    // Never a reply whose only tool call is recordDecision.
    for (const m of messagesOf(d, lead.id).filter((x) => x.role === 'assistant')) {
      const calls = m.content.filter((p) => p.type === 'tool_call').map((p) => p.name);
      if (calls.length > 0)
        expect(calls.every((c) => c === 'orchestrator.recordDecision')).toBe(false);
    }
  });

  it('11. with 10 agents running, a supervisor and a chat still start right away', async () => {
    const s = await scene({ model: 'mock/fast' });
    const agentSessions = [];
    for (let i = 0; i < 11; i++) {
      const a = await s.d.call(HUMAN, 'session.create', {
        kind: 'agent',
        title: `エージェント${i}`,
      });
      agentSessions.push(a);
      await s.d.call(HUMAN, 'session.send', { sessionId: a.id, content: '作業して' });
    }
    await until(() => s.agents.held().length === 10);
    const eleventh = runsOf(s.d, agentSessions[10]!.id)[0]!;
    expect(s.d.ctx.repos.runs.require(eleventh.id).status).toBe('queued');

    const chat = await s.d.call(HUMAN, 'session.create', { kind: 'chat', model: 'mock/fast' });
    const [toLead, toChat] = await Promise.all([
      s.d.call(HUMAN, 'session.send', { sessionId: s.lead.id, content: 'こんにちは' }),
      s.d.call(HUMAN, 'session.send', { sessionId: chat.id, content: 'こんにちは' }),
    ]);
    expect(await s.d.ctx.service('runs').waitForEnd(toLead.runId!)).toMatchObject({
      kind: 'orchestrator',
      status: 'completed',
    });
    expect(await s.d.ctx.service('runs').waitForEnd(toChat.runId!)).toMatchObject({
      kind: 'chat',
      status: 'completed',
    });
    expect(s.d.ctx.repos.runs.require(eleventh.id).status).toBe('queued');
    s.agents.finishAll();
    await until(() => s.d.ctx.repos.runs.require(eleventh.id).status === 'running');
    s.agents.finishAll();
  });
});
