/**
 * Adversarial scenario of the redesign (spec 20261029) at the Control API level: what the
 * user does with a supervising conversation and its children, through a real daemon (every
 * module, the mock agent runtime without pauses, mock models). No real model or API is called.
 *
 * 1. a delegated conversation spawns 3 agents (no workspace / a plain folder / a git worktree)
 *    and 1 chat; home.get shows the tree, states, `now` and cost
 * 2. while they work, the user talks to the supervisor (never rejected, injected at a
 *    boundary), adds a helper, stops and resumes the work
 * 3. a child asks a question → attention with choices → the answer continues it in a new run
 * 4. non-code outputs are readable without git; a code change is reviewed and adopted
 * 5. live cost, budget return, a tight budget, the daily limit
 * 6. daemon restart mid-work
 * 7. schedules on a fake clock
 * 8. the mock supervisor settles; the loop guards open a stuck attention
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Attention, Message, Run, Session } from '@acc/protocol';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { AgentRunInput } from '../contracts';
import { createManualClock } from '../core/clock';
import { setSupervisorLimits } from '../inbox/testkit';
import type { MockResponder } from '../llm/mock';
import { methodForToolName, toolNameForMethod } from '../llm/tools';
import { mockSupervisor } from '../orchestrator/mockSupervisor';
import { modules as defaultModules } from '../modules';
import { MockAgentRuntime } from '../runtime/mock/runtime';
import { createSchedulesModule } from '../schedules';
import { ManualTimers } from '../schedules/testutil';
import {
  HUMAN,
  type TestDaemonNoServer,
  approveIntegrationTests,
  createTestDaemon,
} from '../testing';
import { type TempRepo, createTempRepo, isolateGitConfig } from '../workspace/git-fixture';

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

const DEBOUNCE_MS = 100;

async function until<T>(
  fn: () => T | undefined | null | false,
  what = 'condition',
  timeoutMs = 30_000,
): Promise<T> {
  const started = Date.now();
  for (;;) {
    const v = fn();
    if (v !== undefined && v !== null && v !== false) return v;
    if (Date.now() - started > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 15));
  }
}
const gitShow = (repo: string, spec: string) =>
  execFileSync('git', ['-C', repo, 'show', spec], { encoding: 'utf8' });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A mock plan for a child agent (in its brief). */
const mockPlan = (text: string, steps: unknown[], summary?: string) =>
  [
    text,
    '',
    '```acc-mock',
    JSON.stringify({ steps, delayScale: 0, ...(summary ? { summary } : {}) }),
    '```',
  ].join('\n');

const call = (method: string, input: Record<string, unknown>) => ({
  name: toolNameForMethod(method),
  input,
});

interface World {
  d: TestDaemonNoServer;
  repo: TempRepo;
  folder: string;
  projectId: string;
}

/** A daemon whose mock agent has no pauses, with a project that has a repository and a folder. */
async function world(opts: { home?: string } = {}): Promise<World> {
  const d = await createTestDaemon(opts.home ? { home: opts.home } : {});
  cleanups.push(() => d.cleanup());
  d.ctx.service('llm').mock.chunkDelayMs = 0;
  setSupervisorLimits(d.ctx, { wakeDebounceMs: DEBOUNCE_MS });
  const fast = new MockAgentRuntime({ stepDelayMs: 0, typingDelayMs: 0 });
  vi.spyOn(d.ctx.service('runtimes').get('mock'), 'run').mockImplementation(
    (input: AgentRunInput) => fast.run(input),
  );
  const repo = await createTempRepo({ 'README.md': '# 製品サイト\n' });
  cleanups.push(() => repo.cleanup());
  const folder = mkdtempSync(join(tmpdir(), 'acc-scenario-folder-'));
  cleanups.push(() => rmSync(folder, { recursive: true, force: true, maxRetries: 5 }));
  mkdirSync(join(folder, 'docs'), { recursive: true });
  const project = await d.call(HUMAN, 'project.create', {
    name: 'launch',
    repoPath: repo.path,
    folderPath: folder,
    defaultBranch: 'main',
  });
  return { d, repo, folder, projectId: project.id };
}

const runsOf = (d: TestDaemonNoServer, sessionId: string): Run[] =>
  d.ctx.repos.runs.find({ where: { session_id: sessionId }, direction: 'asc' });
const childrenOf = (d: TestDaemonNoServer, sessionId: string): Session[] =>
  d.ctx.repos.sessions.find({ where: { parent_session_id: sessionId }, direction: 'asc' });
const messagesOf = (d: TestDaemonNoServer, sessionId: string): Message[] =>
  d.ctx.repos.messages.find({ where: { session_id: sessionId }, direction: 'asc' });
const textOf = (m: Message) =>
  m.content
    .filter((p) => p.type === 'text')
    .map((p) => p.text)
    .join('\n');
const lastAssistant = (d: TestDaemonNoServer, sessionId: string) =>
  messagesOf(d, sessionId)
    .filter((m) => m.role === 'assistant')
    .map(textOf)
    .filter(Boolean)
    .at(-1) ?? '';
const activeRun = (d: TestDaemonNoServer, sessionId: string) =>
  runsOf(d, sessionId).find((r) =>
    ['created', 'queued', 'running', 'awaiting_approval'].includes(r.status),
  );
const sessionOf = (d: TestDaemonNoServer, id: string) => d.ctx.repos.sessions.require(id);
const taskOf = (d: TestDaemonNoServer, sessionId: string) =>
  d.ctx.repos.tasks.findOne({ where: { assignee_session_id: sessionId } });
const openAttention = (d: TestDaemonNoServer, sessionId?: string): Attention[] =>
  d.ctx.repos.attention.find({
    where: { status: 'open', ...(sessionId ? { session_id: sessionId } : {}) },
  });

// ---------------------------------------------------------------------------
// 1–5, 8: one supervising conversation, end to end
// ---------------------------------------------------------------------------

const GOAL =
  '来月の新サービス公開に向けて準備を進めて。競合調査、FAQ、サイトの文言、告知の案を頼む';
const QUESTION = '料金を FAQ に書く？';
const LEAD_MODEL = 'mock/scenario-lead';

const TITLES = {
  research: '競合を調べる',
  faq: 'FAQ を書く',
  code: 'サイトの文言を直す',
  chat: '告知の案を出す',
} as const;

/**
 * The supervisor of the scenario: its first reply to the goal spawns the four children the
 * scenario needs (one per kind of workspace and a chat); everything after that is the real
 * mock supervisor (spec §3.13).
 */
function scenarioLead(projectId: string, folder: string): MockResponder {
  return (req, info) => {
    const tools = new Set((req.tools ?? []).map((t) => methodForToolName(t.name)));
    const lastUser = req.messages.findLastIndex((m) => m.role === 'user');
    const arrival = req.messages[lastUser];
    const answered = req.messages.slice(lastUser + 1).some((m) => m.role === 'assistant');
    if (
      !answered &&
      arrival?.role === 'user' &&
      arrival.content === GOAL &&
      tools.has('session.spawn')
    ) {
      return {
        text: '4 つに分けて任せます。',
        toolCalls: [
          call('session.spawn', {
            title: TITLES.research,
            mode: 'agent',
            workspace: { kind: 'none' },
            goal: mockPlan(
              '競合 3 社の料金を調べてまとめてください。',
              [
                { type: 'say', text: '競合 3 社の料金ページを確認します。' },
                { type: 'usage', costUsd: 0.03 },
                { type: 'sleep', ms: 120_000 },
              ],
              '競合 3 社: A 社 1,200 円、B 社 980 円、C 社 無料プランあり。',
            ),
          }),
          call('session.spawn', {
            title: TITLES.faq,
            mode: 'agent',
            workspace: { kind: 'folder', path: folder },
            goal: mockPlan(
              'FAQ を 5 問書いて docs/faq.md に置いてください。',
              [
                { type: 'say', text: '想定される質問を洗い出します。' },
                { type: 'ask', title: QUESTION, choices: ['書く', '書かない'] },
                { type: 'write', path: 'docs/faq.md', content: '# FAQ\n\n- 始め方\n- 料金\n' },
                {
                  type: 'publish',
                  kind: 'document',
                  title: 'FAQ',
                  summary: '5 問の FAQ',
                  path: 'docs/faq.md',
                },
              ],
              'FAQ を書きました。',
            ),
          }),
          call('session.spawn', {
            title: TITLES.code,
            mode: 'agent',
            workspace: { kind: 'worktree', projectId },
            goal: mockPlan('サイトのトップの文言を新サービス向けに直してください。', [
              { type: 'write', path: 'site/top.md', content: '# 新サービス\n\nまもなく公開\n' },
              { type: 'sleep', ms: 120_000 },
            ]),
          }),
          call('session.spawn', {
            title: TITLES.chat,
            mode: 'chat',
            model: 'mock/fast',
            goal: '告知文の案を 1 つください。',
          }),
        ],
      };
    }
    return mockSupervisor(req, info);
  };
}

interface Lead {
  w: World;
  lead: Session;
  children: Record<keyof typeof TITLES, Session>;
}

async function startLead(w: World): Promise<Lead> {
  const { d } = w;
  d.ctx.service('llm').mock.define(LEAD_MODEL, scenarioLead(w.projectId, w.folder), {
    chunkDelayMs: 2,
  });
  const lead = await d.call(HUMAN, 'session.create', {
    kind: 'chat',
    title: '公開準備',
    projectId: w.projectId,
    model: LEAD_MODEL,
  });
  await d.call(HUMAN, 'session.delegate', { sessionId: lead.id });
  const sent = await d.call(HUMAN, 'session.send', { sessionId: lead.id, content: GOAL });
  expect(sent.delivery).toBe('started');
  const run = await d.ctx.service('runs').waitForEnd(sent.runId!);
  expect(run).toMatchObject({ kind: 'orchestrator', status: 'completed' });
  const kids = childrenOf(d, lead.id);
  const byTitle = (t: string) => {
    const s = kids.find((k) => k.title === t);
    if (!s) throw new Error(`no child "${t}" (children: ${kids.map((k) => k.title).join(', ')})`);
    return s;
  };
  return {
    w,
    lead,
    children: {
      research: byTitle(TITLES.research),
      faq: byTitle(TITLES.faq),
      code: byTitle(TITLES.code),
      chat: byTitle(TITLES.chat),
    },
  };
}

describe('scenario: a supervising conversation with four children', () => {
  it('spawns, shows the tree, talks, asks, stops, resumes, adopts and settles', async () => {
    const w = await world();
    const { d } = w;
    const unapprove = approveIntegrationTests(d.ctx);
    cleanups.push(unapprove);
    const { lead, children } = await startLead(w);

    // --- 1. the tree ------------------------------------------------------------------
    // Workspaces: none → a daemon scratch folder, folder → the user's folder, worktree → git.
    const wsOf = (s: Session) =>
      s.workspaceId ? d.ctx.repos.workspaces.require(s.workspaceId) : null;
    expect(wsOf(sessionOf(d, children.research.id))?.kind).toBe('scratch');
    expect(wsOf(sessionOf(d, children.faq.id))).toMatchObject({ kind: 'directory' });
    expect(wsOf(sessionOf(d, children.code.id))?.kind).toBe('worktree');
    expect(wsOf(sessionOf(d, children.chat.id))).toBeNull();
    expect(Object.values(children).map((c) => c.title)).not.toContain(
      expect.stringContaining('Worker'),
    );

    const question = await until(
      () => openAttention(d, children.faq.id).find((a) => a.kind === 'question'),
      'the FAQ question',
    );
    await until(
      () => sessionOf(d, children.research.id).cost.ownUsd >= 0.03,
      'live cost of the research child',
    );
    await until(() => sessionOf(d, children.chat.id).state === 'done', 'the chat child done');

    const home = await d.call(HUMAN, 'home.get', {});
    const tree = home.trees.find((t) => t.root.id === lead.id);
    expect(tree, 'the lead tree is on the home screen').toBeDefined();
    expect(tree!.root).toMatchObject({ role: 'supervisor', state: 'supervising' });
    const card = (id: string) => tree!.nodes.find((n) => n.id === id);
    expect(card(children.research.id)).toMatchObject({
      state: 'working',
      role: 'agent',
      depth: 1,
      startedBy: 'ai',
    });
    expect(card(children.research.id)!.now).toBeTruthy();
    expect(card(children.research.id)!.costUsd).toBeGreaterThanOrEqual(0.03);
    expect(card(children.code.id)).toMatchObject({ state: 'working' });
    expect(card(children.faq.id)).toMatchObject({ state: 'needs_you' });
    expect(card(children.faq.id)!.attentionIds).toContain(question.id);
    expect(card(children.chat.id)).toMatchObject({ state: 'done', role: 'chat' });
    expect(tree!.spend.treeUsd).toBeGreaterThan(0);
    expect(home.totals.needsYou).toBeGreaterThanOrEqual(1);
    expect(home.totals.spendTodayUsd).toBeGreaterThan(0);
    expect(home.attention.map((a) => a.id)).toContain(question.id);

    // --- 2. talking to the supervisor while they work ---------------------------------
    expect(activeRun(d, lead.id)).toBeUndefined();
    const ask = await d.call(HUMAN, 'session.send', {
      sessionId: lead.id,
      content: 'いま何してる？',
    });
    expect(ask.delivery).toBe('started');
    const askRun = await d.ctx.service('runs').waitForEnd(ask.runId!);
    expect(askRun.status).toBe('completed');
    expect(lastAssistant(d, lead.id)).toContain(TITLES.research);

    // A message sent while the supervisor runs is not rejected: it is injected.
    const add = await d.call(HUMAN, 'session.send', { sessionId: lead.id, content: '1人追加して' });
    expect(add.delivery).toBe('started');
    const during = await d.call(HUMAN, 'session.send', {
      sessionId: lead.id,
      content: 'いま何してる？',
    });
    expect(during).toMatchObject({ delivery: 'injected', runId: add.runId });
    await d.ctx.service('runs').waitForEnd(add.runId!);
    expect(d.ctx.repos.messages.require(during.messageId).delivery).toBe('delivered');
    await until(() => !activeRun(d, lead.id), 'the lead idle');
    const added = childrenOf(d, lead.id).filter(
      (c) => !Object.values(children).some((k) => k.id === c.id),
    );
    expect(added, '"1人追加して" adds one child').toHaveLength(1);

    // --- 3. the question --------------------------------------------------------------
    expect(question.choices.map((c) => c.label)).toEqual(['書く', '書かない']);
    expect(question.title).toBe(QUESTION);
    const faqRunsBefore = runsOf(d, children.faq.id).length;
    const write = question.choices.find((c) => c.label === '書く')!;
    await d.call(HUMAN, 'attention.respond', { attentionId: question.id, choiceId: write.id });
    await until(() => runsOf(d, children.faq.id).length > faqRunsBefore, 'the answer run');
    await until(() => taskOf(d, children.faq.id)?.status === 'done', 'the FAQ task done');
    expect(d.ctx.repos.attention.require(question.id).status).toBe('resolved');
    expect(readFileSync(join(w.folder, 'docs', 'faq.md'), 'utf8')).toContain('# FAQ');

    // --- 4. outputs without git -------------------------------------------------------
    const faqOutputs = await d.call(HUMAN, 'artifact.list', {
      sessionId: children.faq.id,
      role: 'output',
    });
    const faqDoc = faqOutputs.items.find((a) => a.kind === 'document');
    expect(faqDoc, 'the FAQ document').toBeDefined();
    const read = await d.call(HUMAN, 'artifact.read', { artifactId: faqDoc!.id });
    expect(read.content).toContain('# FAQ');
    const chatOutputs = await d.call(HUMAN, 'artifact.list', {
      sessionId: children.chat.id,
      role: 'output',
    });
    expect(chatOutputs.items.map((a) => a.kind)).toContain('document');

    // --- 2 (cont.). stop and resume through the supervisor ----------------------------
    const stop = await d.call(HUMAN, 'session.send', { sessionId: lead.id, content: '止めて' });
    await d.ctx.service('runs').waitForEnd(stop.runId!);
    await until(
      () =>
        [children.research, children.code].every(
          (c) => sessionOf(d, c.id).state === 'stopped' && !activeRun(d, c.id),
        ),
      'research and code stopped',
    );
    expect(taskOf(d, children.research.id)?.status).toBe('paused');
    expect(lastAssistant(d, lead.id)).toContain('止めました');

    const resume = await d.call(HUMAN, 'session.send', { sessionId: lead.id, content: '再開して' });
    await d.ctx.service('runs').waitForEnd(resume.runId!);
    expect(lastAssistant(d, lead.id)).toContain('再開しました');
    // The mock agent starts its plan over (it sleeps again): the stop really let it go on.
    await until(
      () =>
        [children.research, children.code].every((c) => activeRun(d, c.id)?.trigger === 'resume'),
      'research and code resumed',
    );
    expect(taskOf(d, children.research.id)?.status).toBe('running');
    expect(sessionOf(d, lead.id).state).toBe('supervising');

    // Talking to a working agent: queued after its run, or (explicitly) interrupting it.
    const resumedCode = activeRun(d, children.code.id)!;
    const queued = await d.call(HUMAN, 'session.send', {
      sessionId: children.code.id,
      content: mockPlan('文言は短めにしてください。', [
        { type: 'append', path: 'site/top.md', content: '\n短く: まもなく\n' },
      ]),
    });
    expect(queued).toMatchObject({ delivery: 'queued' });
    expect(d.ctx.repos.messages.require(queued.messageId).delivery).toBe('queued');
    const cut = await d.call(HUMAN, 'session.send', {
      sessionId: children.code.id,
      content: mockPlan('いまの内容で仕上げてください。', [
        { type: 'say', text: 'いまの内容で仕上げます。' },
      ]),
      interrupt: true,
    });
    expect(cut.runId).toBeTruthy();
    expect((await d.ctx.service('runs').waitForEnd(resumedCode.id)).statusReason).toBe(
      'superseded',
    );
    const resumedResearch = activeRun(d, children.research.id)!;
    await d.call(HUMAN, 'session.send', {
      sessionId: children.research.id,
      content: mockPlan(
        '調べたところまでで、まとめて終えてください。',
        [{ type: 'say', text: '調べたところまでをまとめます。' }],
        '競合 3 社: A 社 1,200 円、B 社 980 円、C 社 無料プランあり。',
      ),
      interrupt: true,
    });
    expect((await d.ctx.service('runs').waitForEnd(resumedResearch.id)).statusReason).toBe(
      'superseded',
    );
    await until(() => taskOf(d, children.research.id)?.status === 'done', 'research done');
    await until(() => taskOf(d, children.code.id)?.status === 'review', 'code in review');
    expect(sessionOf(d, children.research.id).state).toBe('done');
    expect(sessionOf(d, children.code.id).state).toBe('review');
    const researchOutputs = await d.call(HUMAN, 'artifact.list', {
      sessionId: children.research.id,
      role: 'output',
    });
    expect(researchOutputs.items.length).toBeGreaterThan(0);

    // --- 5. budgets: a finished child's unused budget goes back to the parent ----------
    const budgetOf = (sessionId: string) =>
      d.ctx.repos.budgets.findOne({ where: { subject_kind: 'session', subject_id: sessionId } });
    await until(
      () => budgetOf(children.research.id)?.status === 'released',
      'research budget returned',
    );
    const leadBudget = budgetOf(lead.id)!;
    const researchBudget = budgetOf(children.research.id)!;
    expect(researchBudget.spentUsd).toBeGreaterThanOrEqual(0.03);
    expect(researchBudget.spentUsd).toBeLessThan(researchBudget.limitUsd);
    // Only what the children spent stays allocated (nothing of a finished child's slice).
    const settled = Object.values(children).concat(added);
    await until(
      () => settled.every((c) => budgetOf(c.id)?.status !== 'active'),
      'every child budget returned',
    );
    const spentByChildren = settled.reduce((sum, c) => sum + (budgetOf(c.id)?.spentUsd ?? 0), 0);
    expect(budgetOf(lead.id)!.allocatedUsd).toBeCloseTo(spentByChildren, 6);
    expect(leadBudget.limitUsd).toBe(3);

    // --- 8. the supervisor reports once everything finished --------------------------
    await until(
      () => lastAssistant(d, lead.id).includes('すべての作業が終わりました'),
      'the final report',
    );

    // Stopping and resuming the whole tree leaves finished work as it was: the change
    // waiting for review is not paused, and resuming does not run it again.
    const codeRuns = runsOf(d, children.code.id).length;
    const treeStop = await d.call(HUMAN, 'session.stop', { sessionId: lead.id });
    expect(treeStop.stoppedSessionIds).toEqual([lead.id]);
    expect(sessionOf(d, children.code.id).state).toBe('review');
    expect(sessionOf(d, children.research.id).state).toBe('done');
    await d.call(HUMAN, 'session.resume', { sessionId: lead.id, tree: true });
    await sleep(DEBOUNCE_MS * 3);
    expect(runsOf(d, children.code.id)).toHaveLength(codeRuns);
    expect(taskOf(d, children.code.id)?.status).toBe('review');

    // --- 4 (cont.). adopting the code change -----------------------------------------
    const codeOutputs = await d.call(HUMAN, 'artifact.list', {
      sessionId: children.code.id,
      role: 'output',
    });
    const diff = codeOutputs.items.find((a) => a.kind === 'diff');
    expect(diff, 'the code change').toBeDefined();
    expect(diff!.review.state).toBe('pending');
    const reviewItem = openAttention(d).find(
      (a) => a.kind === 'review' && (a.sessionId === children.code.id || a.sessionId === lead.id),
    );
    const adopted = await d.call(HUMAN, 'artifact.review', {
      artifactId: diff!.id,
      decision: 'accept',
    });
    expect(adopted.integrationId).toBeTruthy();
    await until(
      () => d.ctx.repos.integrations.get(adopted.integrationId!)?.status === 'applied',
      'the change applied',
    );
    await until(() => taskOf(d, children.code.id)?.status === 'done', 'code task done');
    expect(d.ctx.repos.artifacts.require(diff!.id).review.state).toBe('accepted');
    expect(gitShow(w.repo.path, 'main:site/top.md')).toContain('新サービス');
    if (reviewItem) {
      await until(
        () => d.ctx.repos.attention.require(reviewItem.id).status !== 'open',
        'the review item closed',
      );
    }

    // --- 8. it settles: no more runs once the work is done -------------------------------
    const quiet = () =>
      d.ctx.repos.runs.count({
        where: { status: ['created', 'queued', 'running', 'awaiting_approval'] },
      }) === 0 && d.ctx.repos.inboxItems.count({ where: { status: 'pending' } }) === 0;
    // The adoption itself is news for the supervisor (the child is done now): one more report.
    await until(
      () => lastAssistant(d, lead.id).includes('「サイトの文言を直す」: 完了'),
      'the report after the adoption',
    );
    await until(quiet, 'every run ended');
    await sleep(DEBOUNCE_MS * 3);
    await until(quiet, 'still quiet');
    const leadRuns = runsOf(d, lead.id).length;
    const events = d.ctx.bus.lastSeq();
    await sleep(DEBOUNCE_MS * 10);
    expect(runsOf(d, lead.id).length).toBe(leadRuns);
    expect(d.ctx.bus.lastSeq()).toBe(events);
    // Wakes stay bounded by the children's changes, and never repeat the same reply.
    const wakes = runsOf(d, lead.id).filter((r) => r.trigger === 'wake').length;
    expect(wakes).toBeLessThanOrEqual(settled.length + 4);
    const texts = messagesOf(d, lead.id)
      .filter((m) => m.role === 'assistant')
      .map(textOf)
      .filter(Boolean);
    for (let i = 1; i < texts.length; i++) expect(texts[i]).not.toBe(texts[i - 1]);
    expect(openAttention(d)).toEqual([]);
    const after = await d.call(HUMAN, 'home.get', {});
    expect(after.totals).toMatchObject({ working: 0, needsYou: 0, failed: 0 });
  });
});

// ---------------------------------------------------------------------------
// 5. budgets that run out, and the daily limit
// ---------------------------------------------------------------------------

describe('scenario: money', () => {
  it('a tight child budget opens a budget item instead of crashing; +$1 lets the work go on', async () => {
    const w = await world();
    const { d } = w;
    const lead = await d.call(HUMAN, 'session.create', {
      kind: 'chat',
      title: '予算の確認',
      projectId: w.projectId,
      model: 'mock/fast',
    });
    await d.call(HUMAN, 'session.delegate', { sessionId: lead.id, budgetUsd: 3 });
    const spawned = await d.call(HUMAN, 'session.spawn', {
      parentSessionId: lead.id,
      title: '高くつく調査',
      mode: 'agent',
      workspace: { kind: 'none' },
      budgetUsd: 0.05,
      goal: mockPlan(
        '大量の資料を読んでまとめてください。',
        [
          { type: 'usage', costUsd: 0.2 },
          { type: 'say', text: '資料を読みました。' },
        ],
        '資料を読んでまとめました。',
      ),
    });
    expect(spawned.budgetId).toBeTruthy();
    const child = spawned.session.id;
    const run = await d.ctx.service('runs').waitForEnd(spawned.runId!);
    expect(run.status).toBe('failed');
    expect(run).toMatchObject({
      statusReason: 'budget_exhausted',
      error: { code: 'budget_exceeded' },
    });
    const item = await until(
      () => openAttention(d, child).find((a) => a.kind === 'budget'),
      'the budget item',
    );
    expect(item.choices.map((c) => c.id)).toEqual(expect.arrayContaining(['add_1', 'stop']));
    expect(openAttention(d, child).filter((a) => a.kind === 'budget')).toHaveLength(1);
    expect(openAttention(d, child).filter((a) => a.kind === 'failure')).toHaveLength(0);
    expect(sessionOf(d, child).state).toBe('needs_you');
    // The overspend is the parent's to carry (spec §3.8-6); nothing else broke.
    expect(d.ctx.repos.budgets.require(spawned.budgetId!).spentUsd).toBeGreaterThan(0.05);
    expect(sessionOf(d, lead.id).cost.treeUsd).toBeGreaterThan(0.05);

    await d.call(HUMAN, 'attention.respond', { attentionId: item.id, choiceId: 'add_1' });
    expect(d.ctx.repos.attention.require(item.id).status).toBe('resolved');
    expect(d.ctx.repos.budgets.require(spawned.budgetId!).limitUsd).toBeCloseTo(1.05, 6);
    // Raising the budget is meant to let the child carry on, not to leave it failed.
    await until(() => runsOf(d, child).length === 2, 'the child runs again');
    await until(() => taskOf(d, child)?.status === 'done', 'the child done');
    expect(sessionOf(d, child).state).toBe('done');
  });

  it('the daily limit stops new spending with one item; +$10 for today closes it', async () => {
    const w = await world();
    const { d } = w;
    const agent = await d.call(HUMAN, 'session.spawn', {
      title: '日次の確認',
      mode: 'agent',
      workspace: { kind: 'none' },
      goal: mockPlan('調べて', [{ type: 'usage', costUsd: 0.2 }], '調べました。'),
    });
    await d.ctx.service('runs').waitForEnd(agent.runId!);
    const used = (await d.call(HUMAN, 'cost.summary', { range: 'today', groupBy: 'root' })).daily
      .usedTodayUsd;
    expect(used).toBeGreaterThanOrEqual(0.2);
    await d.call(HUMAN, 'settings.update', {
      limits: { dailyUsd: used + 0.1, timezone: 'UTC' },
    });

    const over = await d.call(HUMAN, 'session.spawn', {
      title: '上限を越える調査',
      mode: 'agent',
      workspace: { kind: 'none' },
      goal: mockPlan(
        '調べて',
        [
          { type: 'usage', costUsd: 0.5 },
          { type: 'say', text: 'まだ続けます。' },
        ],
        '調べました。',
      ),
    });
    const run = await d.ctx.service('runs').waitForEnd(over.runId!);
    expect(run.status).toBe('failed');
    expect(run.statusReason ?? run.error?.code).toMatch(/daily_limit|budget/);
    const daily = await until(
      () =>
        openAttention(d).find(
          (a) => a.kind === 'budget' && a.choices.some((c) => c.id === 'raise_today_10'),
        ),
      'the daily item',
    );
    // A chat cannot start a model call while today is over the limit.
    const chat = await d.call(HUMAN, 'session.create', { kind: 'chat', model: 'mock/fast' });
    const sent = await d.call(HUMAN, 'session.send', { sessionId: chat.id, content: 'こんにちは' });
    const refused = await d.ctx.service('runs').waitForEnd(sent.runId!);
    expect(refused.status).toBe('failed');
    expect(
      openAttention(d).filter((a) => a.choices.some((c) => c.id === 'raise_today_10')),
    ).toHaveLength(1);
    const home = await d.call(HUMAN, 'home.get', {});
    expect(home.totals.dailyLimitUsd).toBeCloseTo(used + 0.1, 6);
    expect(home.totals.spendTodayUsd).toBeGreaterThan(used);

    await d.call(HUMAN, 'attention.respond', { attentionId: daily.id, choiceId: 'raise_today_10' });
    await until(
      () => d.ctx.repos.attention.require(daily.id).status !== 'open',
      'daily item closed',
    );
    // The work the limit cut off goes on, and the refused chat message gets its answer.
    await until(() => taskOf(d, over.session.id)?.status === 'done', 'the cut-off agent done');
    await until(
      () => runsOf(d, chat.id).some((r) => r.status === 'completed'),
      'the refused chat answered',
    );
    const again = await d.call(HUMAN, 'session.send', { sessionId: chat.id, content: 'もう一度' });
    expect((await d.ctx.service('runs').waitForEnd(again.runId!)).status).toBe('completed');
  });
});

// ---------------------------------------------------------------------------
// 6. a daemon restart in the middle of the work; stopping the whole tree
// ---------------------------------------------------------------------------

describe('scenario: restart', () => {
  it('resumes the supervisor and its children once, keeps the question, leaves no stale state', async () => {
    const home = mkdtempSync(join(tmpdir(), 'acc-scenario-home-'));
    cleanups.push(() => rmSync(home, { recursive: true, force: true, maxRetries: 5 }));
    const w = await world({ home });
    const { lead, children } = await startLead(w);
    const d1 = w.d;
    const question = await until(
      () => openAttention(d1, children.faq.id).find((a) => a.kind === 'question'),
      'the FAQ question',
    );
    await until(
      () => activeRun(d1, children.research.id)?.status === 'running',
      'research running',
    );
    await until(() => activeRun(d1, children.code.id)?.status === 'running', 'code running');
    await until(() => !activeRun(d1, lead.id), 'the lead idle');
    const interrupted = [children.research.id, children.code.id].map((id) => activeRun(d1, id)!.id);
    await d1.close();

    // The second daemon on the same data.
    const d = await createTestDaemon({ home });
    cleanups.push(() => d.close());
    d.ctx.service('llm').mock.chunkDelayMs = 0;
    setSupervisorLimits(d.ctx, { wakeDebounceMs: DEBOUNCE_MS });
    d.ctx.service('llm').mock.define(LEAD_MODEL, scenarioLead(w.projectId, w.folder));
    const fast = new MockAgentRuntime({ stepDelayMs: 0, typingDelayMs: 0 });
    vi.spyOn(d.ctx.service('runtimes').get('mock'), 'run').mockImplementation(
      (input: AgentRunInput) => fast.run(input),
    );

    for (const id of interrupted) expect(d.ctx.repos.runs.require(id).status).toBe('interrupted');
    // The question survives the restart (approvals would be withdrawn, questions are not).
    expect(d.ctx.repos.attention.require(question.id).status).toBe('open');
    // Interrupted children resume by themselves, once each, in their own workspace.
    for (const c of [children.research, children.code]) {
      await until(() => activeRun(d, c.id)?.trigger === 'resume', `${c.title} resumed`);
      expect(runsOf(d, c.id).filter((r) => r.trigger === 'resume')).toHaveLength(1);
      expect(activeRun(d, c.id)!.workspaceId).toBe(sessionOf(d, c.id).workspaceId);
    }
    // The supervisor was idle (event-driven): its grant survived and it waits for news.
    expect(d.ctx.service('policy').sessionAllows(lead.id, 'session.spawn')).toBe(true);
    const leadRunsAtBoot = runsOf(d, lead.id).length;
    // No stale state: whatever shows "working" has a run, the waiting child still needs you.
    await until(() => !activeRun(d, lead.id), 'the lead idle again');
    for (const s of d.ctx.repos.sessions.find({})) {
      if (s.state === 'working')
        expect(activeRun(d, s.id), `${s.title} working without a run`).toBeDefined();
      if (!activeRun(d, s.id)) expect(s.now, `${s.title} keeps a stale "now"`).toBeNull();
    }
    expect(sessionOf(d, children.faq.id).state).toBe('needs_you');
    const home2 = await d.call(HUMAN, 'home.get', {});
    expect(home2.attention.map((a) => a.id)).toContain(question.id);

    // The answer after the restart still reaches the child and starts its next run.
    const faqRuns = runsOf(d, children.faq.id).length;
    await d.call(HUMAN, 'attention.respond', {
      attentionId: question.id,
      choiceId: question.choices.find((c) => c.label === '書かない')!.id,
    });
    await until(() => runsOf(d, children.faq.id).length > faqRuns, 'the answer run');
    const answerRun = runsOf(d, children.faq.id).at(-1)!;
    expect(textOf(d.ctx.repos.messages.require(answerRun.triggerMessageId!))).toContain('書かない');
    await until(() => taskOf(d, children.faq.id)?.status === 'done', 'the FAQ child done');
    // That is news for the supervisor: it is woken and reports (no human message needed).
    await until(
      () =>
        runsOf(d, lead.id)
          .slice(leadRunsAtBoot)
          .some((r) => r.trigger === 'wake' && r.status === 'completed'),
      'the lead woken',
    );
    expect(lastAssistant(d, lead.id)).toContain('件が終わりました');

    // --- stopping the whole tree from its root, and resuming it -----------------------
    const stopped = await d.call(HUMAN, 'session.stop', { sessionId: lead.id });
    expect(stopped.stoppedSessionIds).toEqual(
      expect.arrayContaining([lead.id, children.research.id, children.code.id]),
    );
    await until(
      () => [children.research, children.code].every((c) => !activeRun(d, c.id)),
      'the tree stopped',
    );
    for (const c of [children.research, children.code]) {
      expect(sessionOf(d, c.id).state).toBe('stopped');
      expect(taskOf(d, c.id)?.status).toBe('paused');
    }
    expect(sessionOf(d, lead.id)).toMatchObject({ supervision: 'paused', state: 'stopped' });
    // Finished children are left as they were.
    expect(sessionOf(d, children.faq.id).state).toBe('done');
    // Stopped is not the end: nothing wakes the lead, and resume brings the work back.
    const leadRuns = runsOf(d, lead.id).length;
    await sleep(DEBOUNCE_MS * 4);
    expect(runsOf(d, lead.id).length).toBe(leadRuns);
    const resumed = await d.call(HUMAN, 'session.resume', { sessionId: lead.id, tree: true });
    expect(resumed.resumedSessionIds).toEqual(
      expect.arrayContaining([lead.id, children.research.id, children.code.id]),
    );
    expect(sessionOf(d, lead.id).supervision).toBe('active');
    for (const c of [children.research, children.code]) {
      await until(() => activeRun(d, c.id)?.status === 'running', `${c.title} running again`);
      expect(taskOf(d, c.id)?.status).toBe('running');
    }
    await d.call(HUMAN, 'session.stop', { sessionId: lead.id });
  });
});

// ---------------------------------------------------------------------------
// 7. schedules on a fake clock
// ---------------------------------------------------------------------------

describe('scenario: a daily schedule', () => {
  it('fires a child per run, skips while the previous runs, and runs only the latest missed one', async () => {
    const clock = createManualClock(Date.UTC(2026, 10, 2, 8, 0));
    const timers = new ManualTimers();
    const d = await createTestDaemon({
      clock,
      modules: defaultModules.map((m) =>
        m.name === 'schedules' ? createSchedulesModule({ timers }) : m,
      ),
    });
    cleanups.push(() => d.cleanup());
    d.ctx.service('llm').mock.chunkDelayMs = 0;
    const fast = new MockAgentRuntime({ stepDelayMs: 0, typingDelayMs: 0 });
    vi.spyOn(d.ctx.service('runtimes').get('mock'), 'run').mockImplementation(
      (input: AgentRunInput) => fast.run(input),
    );
    const scheduler = d.ctx.service('scheduler') as unknown as { idle(): Promise<void> };
    const owner = await d.call(HUMAN, 'session.create', {
      kind: 'chat',
      title: '毎朝の確認',
      model: 'mock/fast',
    });
    // The firing child holds until the test lets it go (a marker in the prompt).
    let release = false;
    const prompt = mockPlan(
      '昨日の問い合わせをまとめて',
      [{ type: 'say', text: '問い合わせを確認します。' }],
      '問い合わせ 3 件をまとめました。',
    );
    vi.spyOn(fast, 'run').mockImplementation(async function* (input: AgentRunInput) {
      while (!release && !input.signal.aborted) await sleep(10);
      yield* MockAgentRuntime.prototype.run.call(
        new MockAgentRuntime({ stepDelayMs: 0, typingDelayMs: 0 }),
        input,
      );
    });
    const schedule = await d.call(HUMAN, 'schedule.create', {
      sessionId: owner.id,
      title: '朝のまとめ',
      prompt,
      trigger: { kind: 'cron', expr: '0 9 * * *', tz: 'UTC' },
      run: { mode: 'agent', workspace: { kind: 'none' }, budgetUsd: 1 },
    });
    expect(schedule.nextRunAt).toBe('2026-11-02T09:00:00.000Z');
    expect(timers.delay).toBe(60 * 60 * 1000);
    const home = await d.call(HUMAN, 'home.get', {});
    expect(home.upcoming.map((u) => u.scheduleId)).toContain(schedule.id);
    expect(home.trees.find((t) => t.root.id === owner.id)?.nextRunAt).toBe(schedule.nextRunAt);

    const firings = () => childrenOf(d, owner.id);
    const fireAt = async (ms: number) => {
      clock.set(ms);
      timers.fire();
      await scheduler.idle();
    };

    // 9:00 — a child of the owner, started by the schedule.
    await fireAt(Date.UTC(2026, 10, 2, 9, 0));
    expect(firings()).toHaveLength(1);
    const first = firings()[0]!;
    expect(first).toMatchObject({
      scheduleId: schedule.id,
      kind: 'agent',
      parentSessionId: owner.id,
    });
    expect(first.title).toBe('朝のまとめ · 11/2 9:00');
    expect(runsOf(d, first.id)[0]).toMatchObject({ trigger: 'schedule' });
    expect(d.ctx.repos.schedules.require(schedule.id)).toMatchObject({
      nextRunAt: '2026-11-03T09:00:00.000Z',
      lastRun: { outcome: 'started', sessionId: first.id },
    });

    // The next day while the first one still works: skipped, nothing new.
    await fireAt(Date.UTC(2026, 10, 3, 9, 0));
    expect(firings()).toHaveLength(1);
    expect(d.ctx.repos.schedules.require(schedule.id).lastRun?.outcome).toBe('skipped_overlap');
    release = true;
    await until(() => taskOf(d, first.id)?.status === 'done', 'the first firing done');

    // The machine slept for three days: only the latest missed run fires (on time: 1h late).
    await fireAt(Date.UTC(2026, 10, 7, 10, 0));
    expect(firings()).toHaveLength(2);
    const latest = firings()[1]!;
    expect(latest.title).toBe('朝のまとめ · 11/7 9:00');
    // It carries the previous firing's main output.
    const brief = textOf(messagesOf(d, latest.id)[0]!);
    expect(brief).toContain('問い合わせ 3 件をまとめました');
    await until(() => taskOf(d, latest.id)?.status === 'done', 'the latest firing done');

    // Too late (past maxLatenessMin, 12h): recorded as missed, no child.
    await fireAt(Date.UTC(2026, 10, 8, 23, 0));
    expect(firings()).toHaveLength(2);
    expect(d.ctx.repos.schedules.require(schedule.id)).toMatchObject({
      lastRun: { outcome: 'missed', scheduledFor: '2026-11-08T09:00:00.000Z' },
      nextRunAt: '2026-11-09T09:00:00.000Z',
    });
    // The home screen shows only the latest firing under the owner.
    const after = await d.call(HUMAN, 'home.get', {});
    const tree = after.trees.find((t) => t.root.id === owner.id)!;
    expect(tree.nodes.map((n) => n.id)).toContain(latest.id);
    expect(tree.nodes.map((n) => n.id)).not.toContain(first.id);
    expect(tree.hiddenNodes).toBeGreaterThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// 8. runaway guards
// ---------------------------------------------------------------------------

describe('scenario: a supervisor that would not stop', () => {
  /** A delegated conversation on `responder` (it gets the conversation's id), given a goal. */
  async function stubborn(responder: (leadId: string) => MockResponder) {
    const w = await world();
    const { d } = w;
    let leadId = '';
    d.ctx.service('llm').mock.define('mock/stubborn', (req, info) => responder(leadId)(req, info));
    const lead = await d.call(HUMAN, 'session.create', {
      kind: 'chat',
      title: '止まらない指揮役',
      model: 'mock/stubborn',
    });
    leadId = lead.id;
    await d.call(HUMAN, 'session.delegate', { sessionId: lead.id });
    const sent = await d.call(HUMAN, 'session.send', { sessionId: lead.id, content: '進めて' });
    const run = await d.ctx.service('runs').waitForEnd(sent.runId!);
    return { d, lead, run };
  }

  async function expectStuck(d: TestDaemonNoServer, leadId: string) {
    const item = await until(
      () => openAttention(d, leadId).find((a) => a.kind === 'stuck'),
      'the stuck item',
    );
    expect(item.choices.map((c) => c.id)).toEqual(expect.arrayContaining(['continue', 'stop']));
    expect(sessionOf(d, leadId)).toMatchObject({ supervision: 'paused', state: 'needs_you' });
    // Nothing wakes it while it is paused, even news from a child.
    const runs = runsOf(d, leadId).length;
    d.ctx.service('inbox').deliver(leadId, {
      kind: 'resume',
      refs: {},
      actor: { kind: 'system', component: 'test' },
    });
    await sleep(DEBOUNCE_MS * 4);
    expect(runsOf(d, leadId)).toHaveLength(runs);
    return item;
  }

  it('the same tool call over and over: loop_detected and a stuck item', async () => {
    let calls = 0;
    const { d, lead, run } = await stubborn((leadId) => () => {
      calls += 1;
      return { text: '木を確かめます。', toolCalls: [call('session.tree', { sessionId: leadId })] };
    });
    expect(run).toMatchObject({ status: 'failed', statusReason: 'loop_detected' });
    expect(calls).toBe(3);
    const item = await expectStuck(d, lead.id);
    // "続ける" lets it run again (the human takes the responsibility).
    await d.call(HUMAN, 'attention.respond', { attentionId: item.id, choiceId: 'continue' });
    expect(sessionOf(d, lead.id).supervision).toBe('active');
    expect(d.ctx.repos.attention.require(item.id).status).toBe('resolved');
  });

  it('a different tool call every time: turn_limit after maxModelCallsPerRun', async () => {
    let calls = 0;
    const { d, lead, run } = await stubborn((leadId) => () => {
      calls += 1;
      return {
        text: `確認 ${calls} 回目`,
        toolCalls: [call('attention.list', { sessionId: leadId, limit: calls })],
      };
    });
    expect(run).toMatchObject({ status: 'failed', statusReason: 'turn_limit' });
    expect(calls).toBe(24);
    await expectStuck(d, lead.id);
  });
});
