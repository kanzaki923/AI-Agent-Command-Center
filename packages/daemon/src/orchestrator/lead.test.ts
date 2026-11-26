/**
 * A code conversation leads its own children (orchestrator/grant.ts ensureLeadGrant): asked to
 * work in parallel, the Claude Code conversation splits the work into children with their own
 * worktrees cut from its branch, is woken as they finish, and combines their work with its
 * own through an integration. No button: the daemon bounds what it may do.
 */
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Project, Session, Workspace } from '@acc/protocol';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { AgentRunInput } from '../contracts';
import { ApiError } from '../core/errors';
import { insertRun, setRunStatus } from '../policy/testutil';
import { decideToolPermission } from '../runtime/policy';
import { MockAgentRuntime } from '../runtime/mock/runtime';
import { conversationFrame } from '../sessions/framing';
import { HUMAN, type TestDaemonNoServer, agentActor, createTestDaemon } from '../testing';
import { gitOut } from '../workspace/git';
import { type TempRepo, createTempRepo, isolateGitConfig } from '../workspace/git-fixture';
import { LEAD_MAX_CHILDREN, LEAD_REASON, ensureLeadGrant, supervisorGrantsOf } from './grant';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 60_000 });

let restoreGit: () => void;
beforeAll(() => {
  restoreGit = isolateGitConfig();
});
afterAll(() => restoreGit());

const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn();
});

async function until<T>(fn: () => T | undefined | null | false, timeoutMs = 30_000): Promise<T> {
  const started = Date.now();
  for (;;) {
    const v = fn();
    if (v !== undefined && v !== null && v !== false) return v;
    if (Date.now() - started > timeoutMs) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 10));
  }
}

async function codeOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return 'ok';
  } catch (err) {
    return err instanceof ApiError ? err.code : String(err);
  }
}

interface Scene {
  d: TestDaemonNoServer;
  repo: TempRepo;
  project: Project;
  lead: Session;
  ws: Workspace;
  inputs: AgentRunInput[];
}

/** A repository project and a top-level code conversation in a worktree of it. */
async function scene(): Promise<Scene> {
  const d = await createTestDaemon();
  cleanups.push(() => d.cleanup());
  const repo = await createTempRepo({ 'README.md': '# app\n' });
  cleanups.push(() => repo.cleanup());
  const fast = new MockAgentRuntime({ stepDelayMs: 0, typingDelayMs: 0 });
  const inputs: AgentRunInput[] = [];
  vi.spyOn(d.ctx.service('runtimes').get('mock'), 'run').mockImplementation((i) => {
    inputs.push(i);
    return fast.run(i);
  });
  const project = await d.call(HUMAN, 'project.create', { name: 'app', repoPath: repo.path });
  const lead = await d.call(HUMAN, 'session.create', {
    kind: 'agent',
    title: 'ログイン改善',
    projectId: project.id,
    workspace: { kind: 'worktree', projectId: project.id },
  });
  const ws = d.ctx.repos.workspaces.require(lead.workspaceId!);
  return { d, repo, project, lead, ws, inputs };
}

/** A run of the lead that is still working in its worktree (the caller of the tools below). */
function leadRun(s: Scene) {
  const run = insertRun(s.d.ctx, { sessionId: s.lead.id, projectId: s.project.id });
  s.d.ctx.repos.runs.update(run.id, (r) => ({ ...r, workspaceId: s.ws.id }));
  return agentActor(s.lead.id, run.id);
}

describe('a code conversation leads its own children', () => {
  it('gets the tools to split its work on its first run, and is told how to use them', async () => {
    const s = await scene();
    await s.d.call(HUMAN, 'session.send', {
      sessionId: s.lead.id,
      content: [{ type: 'text', text: 'README を直して' }],
    });
    await until(() => s.inputs.length > 0);
    const [grant] = supervisorGrantsOf(s.d.ctx, s.lead.id);
    expect(grant).toMatchObject({
      reason: LEAD_REASON,
      scope: { projectIds: [s.project.id] },
      limits: { maxChildren: LEAD_MAX_CHILDREN, maxDepth: 1, maxSchedules: 0 },
    });
    expect(grant!.permissions).toEqual(
      expect.arrayContaining(['session.spawn', 'integration.create', 'integration.run']),
    );
    expect(grant!.permissions).not.toContain('schedule.*');
    // The first run already has them: the grant comes before its tools and its frame.
    const input = s.inputs[0]!;
    expect(input.tools?.map((t) => t.method)).toEqual(
      expect.arrayContaining(['session.spawn', 'integration.create']),
    );
    expect(input.systemPrompt).toContain('Working in parallel');
    expect(input.systemPrompt).toContain(`"projectId":"${s.project.id}"`);
    expect(input.systemPrompt).toContain(`sessionIds (the children, then yourself: ${s.lead.id})`);
    // Once is enough.
    expect(ensureLeadGrant(s.d.ctx, s.lead, s.ws)).toBeNull();
    expect(supervisorGrantsOf(s.d.ctx, s.lead.id)).toHaveLength(1);
  });

  it('leaves children, chats, folders and plain repositories alone', async () => {
    const s = await scene();
    const { ctx } = s.d;
    const chat = await s.d.call(HUMAN, 'session.create', {
      title: '相談',
      projectId: s.project.id,
    });
    expect(ensureLeadGrant(ctx, chat, s.ws)).toBeNull();
    expect(ensureLeadGrant(ctx, { ...s.lead, parentSessionId: chat.id }, s.ws)).toBeNull();
    expect(ensureLeadGrant(ctx, { ...s.lead, scheduleId: 'sch_1' }, s.ws)).toBeNull();
    expect(ensureLeadGrant(ctx, s.lead, { kind: 'directory', projectId: s.project.id })).toBeNull();
    expect(ensureLeadGrant(ctx, s.lead, { kind: 'scratch', projectId: null })).toBeNull();
    expect(supervisorGrantsOf(ctx, s.lead.id)).toHaveLength(0);
    // A conversation that does not lead is told nothing about it.
    expect(conversationFrame(ctx, s.lead, { kind: 'agent' })).not.toContain('Working in parallel');
  });

  it("cuts a child's worktree from the lead's branch, with the lead's changes so far", async () => {
    const s = await scene();
    ensureLeadGrant(s.d.ctx, s.lead, s.ws);
    writeFileSync(join(s.ws.path, 'wip.txt'), '途中の作業\n');
    const { session: child } = await s.d.call(leadRun(s), 'session.spawn', {
      title: 'テストを書く',
      goal: 'ログインのテストを書く',
      mode: 'agent',
      workspace: { kind: 'worktree', projectId: s.project.id },
    });
    const childWs = s.d.ctx.repos.workspaces.require(child.workspaceId!);
    expect(childWs.kind).toBe('worktree');
    expect(childWs.path).not.toBe(s.ws.path);
    // The child starts on top of what the lead had done, not on the default branch.
    expect(existsSync(join(childWs.path, 'wip.txt'))).toBe(true);
    expect(await gitOut(s.ws.path, ['log', '-1', '--format=%s'])).toBe(
      '会話「ログイン改善」の途中の変更',
    );
    expect(await gitOut(s.ws.path, ['status', '--porcelain'])).toBe('');
    // A base the lead names is kept as it is.
    const { session: fromMain } = await s.d.call(leadRun(s), 'session.spawn', {
      title: 'main から',
      goal: 'main から始める',
      mode: 'agent',
      workspace: { kind: 'worktree', projectId: s.project.id, baseRef: 'main' },
    });
    const mainWs = s.d.ctx.repos.workspaces.require(fromMain.workspaceId!);
    expect(existsSync(join(mainWs.path, 'wip.txt'))).toBe(false);
  });

  it('is woken as a Claude Code run when its child finishes, instead of waiting', async () => {
    const s = await scene();
    ensureLeadGrant(s.d.ctx, s.lead, s.ws);
    const actor = leadRun(s);
    const plan = JSON.stringify({
      steps: [{ type: 'write', path: 'login.test.ts', content: 'test\n' }],
      summary: 'テストを書きました',
      delayScale: 0,
    });
    await s.d.call(actor, 'session.spawn', {
      title: 'テストを書く',
      goal: `ログインのテストを書く\n\`\`\`acc-mock\n${plan}\n\`\`\``,
      mode: 'agent',
      workspace: { kind: 'worktree', projectId: s.project.id },
    });
    // The lead's turn ends after starting the child (its run would hand the update over).
    setRunStatus(s.d.ctx, actor.runId, 'completed');
    const wake = await until(() =>
      s.d.ctx.repos.runs
        .find({ where: { session_id: s.lead.id } })
        .find((r) => r.trigger === 'wake'),
    );
    expect(wake.kind).toBe('agent');
    expect(wake.workspaceId).toBe(s.ws.id);
    const text = s.d.ctx.repos.messages.require(wake.triggerMessageId!);
    expect(JSON.stringify(text.content)).toContain('[状況の更新]');
  });

  it("combines the children's work with its own by naming the conversations", async () => {
    const s = await scene();
    ensureLeadGrant(s.d.ctx, s.lead, s.ws);
    const actor = leadRun(s);
    const { session: child } = await s.d.call(actor, 'session.spawn', {
      title: 'テストを書く',
      goal: 'ログインのテストを書く',
      mode: 'agent',
      workspace: { kind: 'worktree', projectId: s.project.id },
    });
    writeFileSync(join(s.ws.path, 'lead.txt'), 'リードの変更\n');
    const integration = await s.d.call(actor, 'integration.create', {
      projectId: s.project.id,
      sessionIds: [child.id, s.lead.id],
    });
    // The child's task is part of it (applying settles it), and the lead's own changes
    // were committed although its run holds the worktree: the run is the caller.
    expect(integration.taskIds).toEqual([child.taskId]);
    expect(integration.steps.filter((st) => st.kind === 'merge')).toHaveLength(2);
    expect(await gitOut(s.ws.path, ['status', '--porcelain'])).toBe('');

    // Only conversations of its own tree, and one way of naming the sources.
    const other = await s.d.call(HUMAN, 'session.create', {
      kind: 'agent',
      title: '別の会話',
      projectId: s.project.id,
      workspace: { kind: 'worktree', projectId: s.project.id },
    });
    expect(
      await codeOf(
        s.d.call(actor, 'integration.create', { projectId: s.project.id, sessionIds: [other.id] }),
      ),
    ).toBe('forbidden');
    expect(
      await codeOf(
        s.d.call(HUMAN, 'integration.create', {
          projectId: s.project.id,
          sessionIds: [child.id],
          workspaceIds: [s.ws.id],
        }),
      ),
    ).toBe('invalid_params');
  });
});

describe('a lead stays an agent, inside its own tree', () => {
  it('shows as an agent (nothing to delegate) and cannot combine another conversation by its worktree', async () => {
    const s = await scene();
    ensureLeadGrant(s.d.ctx, s.lead, s.ws);
    const tree = await s.d.call(HUMAN, 'session.tree', { sessionId: s.lead.id });
    expect(tree.nodes.find((n) => n.id === s.lead.id)?.role).toBe('agent');
    const other = await s.d.call(HUMAN, 'session.create', {
      kind: 'agent',
      title: '別の会話',
      projectId: s.project.id,
      workspace: { kind: 'worktree', projectId: s.project.id },
    });
    const theirs = s.d.ctx.repos.workspaces.require(other.workspaceId!).path;
    writeFileSync(join(theirs, 'theirs.txt'), 'x');
    expect(
      await codeOf(
        s.d.call(leadRun(s), 'integration.create', {
          projectId: s.project.id,
          workspaceIds: [other.workspaceId!],
        }),
      ),
    ).toBe('forbidden');
    // Nothing of theirs was committed on the way.
    expect(await gitOut(theirs, ['status', '--porcelain'])).toContain('theirs.txt');
  });

  it("brings in a stopped child's uncommitted changes, as any conversation's", async () => {
    const s = await scene();
    ensureLeadGrant(s.d.ctx, s.lead, s.ws);
    const actor = leadRun(s);
    const { session: child, runId } = await s.d.call(actor, 'session.spawn', {
      title: 'テストを書く',
      goal: 'ログインのテストを書く',
      mode: 'agent',
      workspace: { kind: 'worktree', projectId: s.project.id },
    });
    if (runId) await s.d.ctx.service('runs').waitForEnd(runId);
    const childPath = s.d.ctx.repos.workspaces.require(child.workspaceId!).path;
    writeFileSync(join(childPath, 'half.txt'), '書きかけ');
    await s.d.call(actor, 'integration.create', {
      projectId: s.project.id,
      sessionIds: [child.id, s.lead.id],
    });
    expect(await gitOut(childPath, ['status', '--porcelain'])).toBe('');
  });
});

describe('making worktrees by hand is refused, with the way to split work', () => {
  const cwd = process.platform === 'win32' ? 'C:\\work\\ws' : '/work/ws';
  it('git worktree and a subagent in its own worktree point at session_spawn', () => {
    for (const r of [
      decideToolPermission({ toolName: 'Bash', input: { command: 'git worktree add ../x' }, cwd }),
      decideToolPermission({
        toolName: 'Agent',
        input: { prompt: 'テストを書く', isolation: 'worktree' },
        cwd,
      }),
    ]) {
      expect(r).toMatchObject({ decision: 'deny', rule: 'git_metadata' });
      expect(r.message).toContain('session_spawn');
    }
    // A plain subagent stays allowed.
    expect(
      decideToolPermission({ toolName: 'Agent', input: { prompt: '調べる' }, cwd }).decision,
    ).not.toBe('deny');
  });
});
