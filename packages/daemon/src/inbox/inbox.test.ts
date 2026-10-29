/**
 * Unit-level checks of T1's pieces: session.delegate / undelegate, the inbox's item rules,
 * wake entries, transient-error classification, the slot pools and which tools a supervisor
 * gets.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { apiTools } from '../llm/tools';
import { MOCK_ORCHESTRATOR_MODEL } from '../orchestrator/mockModel';
import { SUPERVISOR_CODE_PERMISSIONS, SUPERVISOR_PERMISSIONS } from '../orchestrator/grant';
import { buildSupervisorPrompt, treeSnapshot } from '../orchestrator/executor';
import { HUMAN, SYSTEM, type TestDaemonNoServer, agentActor, createTestDaemon } from '../testing';
import { createTempRepo, isolateGitConfig } from '../workspace/git-fixture';
import { isTransientRunError } from './service';
import { installChildAgents, setSupervisorLimits } from './testkit';
import { WAKE_MARKER, wakeEntries, wakeText } from './wake';

let d: TestDaemonNoServer | null = null;
afterEach(async () => {
  await d?.cleanup();
  d = null;
});

async function until<T>(fn: () => T | undefined | null | false, timeoutMs = 5000): Promise<T> {
  const started = Date.now();
  for (;;) {
    const v = fn();
    if (v !== undefined && v !== null && v !== false) return v;
    if (Date.now() - started > timeoutMs) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe('session.delegate / session.undelegate', () => {
  it('gives a chat the supervisor preset with the defaults (4 children, $3, session lifetime)', async () => {
    d = await createTestDaemon();
    const s = await d.call(HUMAN, 'session.create', { kind: 'chat' });
    const { grant, budget } = await d.call(HUMAN, 'session.delegate', { sessionId: s.id });
    expect(grant).toMatchObject({
      subject: { kind: 'session', sessionId: s.id },
      lifetime: 'session',
      limits: { maxChildren: 4, maxDepth: 1, maxSchedules: 5 },
      scope: {},
    });
    expect(grant.permissions).toEqual([...SUPERVISOR_PERMISSIONS, 'schedule.*']);
    expect(budget).toMatchObject({ limitUsd: 3, subject: { kind: 'session', id: s.id } });
    // Not in the preset: humans' decisions and the blocking waits.
    for (const p of ['integration.approve', 'approval.respond', 'grant.create', 'task.wait']) {
      expect(grant.permissions).not.toContain(p);
    }
    expect(d.ctx.service('policy').sessionAllows(s.id, 'session.spawn')).toBe(true);
  });

  it('adds the code permissions only for a project with a repository; schedules can be left out', async () => {
    const restore = isolateGitConfig();
    const repo = await createTempRepo();
    try {
      d = await createTestDaemon();
      const code = await d.call(HUMAN, 'project.create', {
        name: 'code',
        repoPath: repo.path,
        defaultBranch: 'main',
      });
      const plain = await d.call(HUMAN, 'project.create', { name: 'docs' });
      const a = await d.call(HUMAN, 'session.create', { kind: 'chat', projectId: code.id });
      const b = await d.call(HUMAN, 'session.create', { kind: 'chat', projectId: plain.id });
      const ga = (await d.call(HUMAN, 'session.delegate', { sessionId: a.id })).grant;
      const gb = (
        await d.call(HUMAN, 'session.delegate', { sessionId: b.id, allowSchedules: false })
      ).grant;
      for (const p of SUPERVISOR_CODE_PERMISSIONS) expect(ga.permissions).toContain(p);
      expect(ga.scope).toEqual({ projectIds: [code.id] });
      expect(gb.permissions).toEqual([...SUPERVISOR_PERMISSIONS]);
      expect(gb.limits.maxSchedules).toBe(0);
    } finally {
      await d?.cleanup();
      d = null;
      await repo.cleanup();
      restore();
    }
  });

  it('is for humans and chats only; delegating again replaces the grant and keeps the budget', async () => {
    d = await createTestDaemon();
    const s = await d.call(HUMAN, 'session.create', { kind: 'chat' });
    const first = await d.call(HUMAN, 'session.delegate', { sessionId: s.id, maxChildren: 2 });
    const agent = agentActor(s.id, d.ctx.ids.next('run'));
    await expect(d.call(agent, 'session.delegate', { sessionId: s.id })).rejects.toMatchObject({
      code: 'forbidden',
    });
    const worker = await d.call(HUMAN, 'session.create', { kind: 'agent' });
    await expect(d.call(HUMAN, 'session.delegate', { sessionId: worker.id })).rejects.toMatchObject(
      {
        code: 'invalid_params',
      },
    );
    const again = await d.call(HUMAN, 'session.delegate', { sessionId: s.id, maxChildren: 6 });
    expect(again.grant.limits.maxChildren).toBe(6);
    expect(again.budget?.id).toBe(first.budget?.id);
    expect(d.ctx.repos.grants.require(first.grant.id).revokedAt).not.toBeNull();

    const { revoked } = await d.call(HUMAN, 'session.undelegate', { sessionId: s.id });
    expect(revoked).toEqual([again.grant.id]);
    expect(d.ctx.service('policy').sessionAllows(s.id, 'session.spawn')).toBe(false);
  });

  it('a supervisor no longer gets task.wait / integration.wait as tools', async () => {
    d = await createTestDaemon();
    const s = await d.call(HUMAN, 'session.create', { kind: 'chat' });
    await d.call(HUMAN, 'session.delegate', { sessionId: s.id });
    const names = apiTools(d.ctx, agentActor(s.id, d.ctx.ids.next('run'))).map((t) => t.method);
    expect(names).toContain('session.stop');
    expect(names).not.toContain('task.wait');
    expect(names).not.toContain('integration.wait');
  });
});

describe('inbox items', () => {
  it('a newer update of the same child replaces the pending one; drain hands over messages only', async () => {
    d = await createTestDaemon();
    setSupervisorLimits(d.ctx, { wakeDebounceMs: 60_000 });
    const lead = await d.call(HUMAN, 'session.create', {
      kind: 'chat',
      model: MOCK_ORCHESTRATOR_MODEL,
    });
    await d.call(HUMAN, 'session.delegate', { sessionId: lead.id });
    const child = await d.call(HUMAN, 'session.create', {
      kind: 'agent',
      parentSessionId: lead.id,
    });
    const inbox = d.ctx.service('inbox');
    const a = inbox.deliver(lead.id, {
      kind: 'child_update',
      refs: { childSessionId: child.id },
      actor: SYSTEM,
    });
    const b = inbox.deliver(lead.id, {
      kind: 'child_update',
      refs: { childSessionId: child.id },
      actor: SYSTEM,
    });
    expect(a.delivery).toBe('queued');
    expect(d.ctx.repos.inboxItems.require(a.item!.id).status).toBe('dropped');
    expect(d.ctx.repos.inboxItems.require(b.item!.id).status).toBe('pending');
    expect(d.ctx.bus.list({ types: ['inbox.added'] }).events).toHaveLength(2);
    // Not a message: a running run does not take it at a step boundary.
    const run = d.ctx.service('runs').start({
      sessionId: lead.id,
      kind: 'chat',
      createdBy: HUMAN,
    });
    expect(inbox.drain(run.id)).toEqual([]);
    await d.ctx.service('runs').waitForEnd(run.id);
    expect(d.ctx.repos.inboxItems.require(b.item!.id).status).toBe('pending');
  });

  it('wake entries read the child now: stale ones are left out, answers and budgets get a line', async () => {
    d = await createTestDaemon();
    const lead = await d.call(HUMAN, 'session.create', { kind: 'chat', title: '指揮' });
    const child = await d.call(HUMAN, 'session.create', {
      kind: 'agent',
      title: '調べる',
      parentSessionId: lead.id,
    });
    const now = d.ctx.clock.iso();
    const item = (kind: 'child_update' | 'budget' | 'resume', refs = {}) =>
      d!.ctx.repos.inboxItems.insert({
        id: d!.ctx.ids.next('inboxItem'),
        sessionId: lead.id,
        kind,
        refs,
        status: 'pending',
        consumedByRunId: null,
        createdAt: now,
      });
    const leadNow = d.ctx.repos.sessions.require(lead.id);
    // The child never ran: idle, so its update went stale.
    expect(
      wakeEntries(d.ctx, leadNow, [item('child_update', { childSessionId: child.id })]),
    ).toEqual([]);
    const entries = wakeEntries(d.ctx, leadNow, [item('budget'), item('resume')]);
    expect(entries.map((e) => e.view.change)).toEqual(['budget', 'resume']);
    const text = wakeText(entries);
    expect(text.startsWith(`${WAKE_MARKER}\n`)).toBe(true);
    expect(text).toContain('デーモンの再起動で中断されました');
  });

  it('a supervisor stopped by its budget is left to the budget item (no failure, no retry)', async () => {
    d = await createTestDaemon();
    const lead = await d.call(HUMAN, 'session.create', { kind: 'chat', model: 'mock/fast' });
    await d.call(HUMAN, 'session.delegate', { sessionId: lead.id, budgetUsd: 0.01 });
    const open = vi.spyOn(d.ctx.service('attention'), 'open');
    const sent = await d.call(HUMAN, 'session.send', { sessionId: lead.id, content: 'やあ' });
    expect(await d.ctx.service('runs').waitForEnd(sent.runId!)).toMatchObject({
      status: 'failed',
      statusReason: 'budget_exhausted',
    });
    expect(open).not.toHaveBeenCalled();
  });

  it('classifies transient LLM errors (429 / 5xx / timeouts) for the retry', () => {
    expect(isTransientRunError({ code: 'llm_timeout', message: '' })).toBe(true);
    expect(isTransientRunError({ code: 'llm_unreachable', message: '' })).toBe(true);
    expect(
      isTransientRunError({
        code: 'llm_http_error',
        message: 'LLM の呼び出しに失敗しました（HTTP 429）',
      }),
    ).toBe(true);
    expect(isTransientRunError({ code: 'llm_http_error', message: '（HTTP 503）' })).toBe(true);
    expect(isTransientRunError({ code: 'llm_http_error', message: '（HTTP 400）' })).toBe(false);
    expect(isTransientRunError({ code: 'budget_exceeded', message: '' })).toBe(false);
    expect(isTransientRunError(null)).toBe(false);
  });
});

describe('supervisor context', () => {
  it('the prompt is neutral without a repository and mentions code only with one', () => {
    const neutral = buildSupervisorPrompt({ project: null, grant: null, maxModelCalls: 24 });
    for (const word of ['git', 'worktree', 'test command', 'coding']) {
      expect(neutral).not.toContain(word);
    }
    expect(neutral).toContain(WAKE_MARKER);
  });

  it('the tree snapshot lists the sessions with their state', async () => {
    d = await createTestDaemon();
    const lead = await d.call(HUMAN, 'session.create', { kind: 'chat', title: '指揮' });
    await d.call(HUMAN, 'session.create', { kind: 'agent', title: '子', parentSessionId: lead.id });
    const text = treeSnapshot(d.ctx, d.ctx.repos.sessions.require(lead.id));
    expect(text).toMatch(new RegExp(`- \\[${lead.id}\\] 「指揮」（この会話） state=`));
    expect(text).toMatch(/\n {2}- \[ses_[0-9a-z]+\] 「子」 state=idle/);
  });
});

describe('slot pools', () => {
  it('agents and LLM-only runs queue separately (maxConcurrentAgents / maxConcurrentChats)', async () => {
    d = await createTestDaemon();
    d.ctx.service('llm').mock.chunkDelayMs = 0;
    await d.call(HUMAN, 'settings.update', { maxConcurrentAgents: 1, maxConcurrentChats: 1 });
    const agents = installChildAgents(d.ctx);
    const a1 = await d.call(HUMAN, 'session.create', { kind: 'agent' });
    const a2 = await d.call(HUMAN, 'session.create', { kind: 'agent' });
    const r1 = await d.call(HUMAN, 'session.send', { sessionId: a1.id, content: '1' });
    const r2 = await d.call(HUMAN, 'session.send', { sessionId: a2.id, content: '2' });
    await until(() => agents.held().length === 1);
    expect(d.ctx.repos.runs.require(r2.runId!).status).toBe('queued');
    // The agent pool is full; a chat still runs.
    const c = await d.call(HUMAN, 'session.create', { kind: 'chat', model: 'mock/fast' });
    const rc = await d.call(HUMAN, 'session.send', { sessionId: c.id, content: 'やあ' });
    expect(await d.ctx.service('runs').waitForEnd(rc.runId!)).toMatchObject({
      status: 'completed',
    });
    expect(d.ctx.repos.runs.require(r1.runId!).status).toBe('running');
    agents.finishAll();
    await until(() => d!.ctx.repos.runs.require(r2.runId!).status === 'running');
    agents.finishAll();
  });
});
