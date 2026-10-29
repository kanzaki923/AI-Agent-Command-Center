/**
 * Visual fixture (dev only): starts the REAL Core Daemon in this process and builds a
 * realistic multi-agent scene through the real Control API — a temporary git repository as
 * the project, an orchestrator chat with its grant, tasks with dependencies, mock-runtime
 * workers that really edit their worktrees (one waits for an approval), a failed run, and an
 * integration candidate that really merged and ran the project's tests.
 *
 * Nothing here is a stand-in: every row the UI shows comes from daemon state, so the scene
 * never masks real behaviour. Used for screenshots and manual QA.
 *
 *   pnpm --filter @acc/desktop scene                      # fresh temp ACC_HOME, port 47899
 *   ACC_HOME=<dir> ACC_PORT=<port> pnpm --filter @acc/desktop scene [--load 10] [--empty]
 *
 * --load N   additionally start N chat sessions streaming at once (feel / perf check)
 * --empty    start the daemon only (onboarding / demo flow)
 *
 * Point the UI at the same ACC_HOME: `ACC_HOME=<dir> pnpm --filter @acc/desktop dev`.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Actor, MethodName, ParamsInput, Result } from '@acc/protocol';

// node:sqlite prints an ExperimentalWarning on load; expected.
const originalEmitWarning = process.emitWarning.bind(process);
process.emitWarning = (warning: string | Error, ...rest: unknown[]) => {
  const msg = typeof warning === 'string' ? warning : warning.message;
  if (msg.includes('SQLite is an experimental feature')) return;
  (originalEmitWarning as (...a: unknown[]) => void)(warning, ...rest);
};

const arg = (name: string): string | null => {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return null;
  const v = process.argv[i + 1];
  return v && !v.startsWith('--') ? v : '';
};

const HUMAN: Actor = { kind: 'human', client: 'scene' };
const home = process.env.ACC_HOME || mkdtempSync(join(tmpdir(), 'acc-scene-'));
process.env.ACC_HOME = home;
process.env.ACC_PORT ??= '47899';

const plan = (steps: unknown[], summary?: string, delayScale = 0.6) =>
  `\n\n\`\`\`acc-mock\n${JSON.stringify({ steps, ...(summary ? { summary } : {}), delayScale })}\n\`\`\``;

async function main(): Promise<void> {
  // Imported after the warning filter is installed (like the daemon's own main.ts).
  const { createLogger, parseLogLevel } = await import('../../../packages/daemon/src/core/log');
  const { startDaemon } = await import('../../../packages/daemon/src/daemon');
  const { createTempRepo } = await import('../../../packages/daemon/src/workspace/git-fixture');
  const daemon = await startDaemon({
    home,
    log: createLogger(parseLogLevel(process.env.ACC_LOG_LEVEL ?? 'warn')),
  });
  const call = <M extends MethodName>(
    m: M,
    p: ParamsInput<M>,
    actor: Actor = HUMAN,
  ): Promise<Result<M>> => daemon.call(actor, m, p as never);
  const until = async <T>(
    fn: () => Promise<T | null | undefined | false>,
    ms = 20_000,
  ): Promise<T> => {
    const end = Date.now() + ms;
    for (;;) {
      const v = await fn();
      if (v) return v;
      if (Date.now() > end) throw new Error('scene: timed out waiting');
      await new Promise((r) => setTimeout(r, 100));
    }
  };

  const stop = () => {
    void daemon.close().finally(() => process.exit(0));
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  console.log(`ACC_HOME=${home}`);
  console.log(`daemon ${daemon.url}`);
  if (arg('empty') !== null) {
    console.log('empty scene: daemon only');
    return;
  }

  // ---------------------------------------------------------------- project (a real repo)
  const repo = await createTempRepo({
    'README.md': '# acme-web\n\n社内向けの Web アプリです。\n',
    'src/auth/session.ts': [
      'export interface Session {',
      '  userId: string;',
      '  expiresAt: number;',
      '}',
      '',
      'export function isExpired(session: Session): boolean {',
      '  return Date.now() > session.expiresAt;',
      '}',
      '',
    ].join('\n'),
    'scripts/test.js': [
      "const files = ['auth/session', 'auth/login', 'api/users'];",
      'for (const f of files) console.log(`✓ ${f}.test.ts`);',
      "console.log('\\nTest Files  3 passed (3)\\n     Tests  24 passed (24)');",
      '',
    ].join('\n'),
  });
  const project = await call('project.create', {
    name: 'acme-web',
    repoPath: repo.path,
    defaultBranch: 'main',
    testCommand: 'node scripts/test.js',
  });
  await call('workspace.create', { projectId: project.id, kind: 'main' });
  await call('project.create', {
    name: 'docs-site',
    description: 'ドキュメントサイト（リポジトリ未設定）',
  });

  // ---------------------------------------------------------------- orchestrator chat
  const design = await call('session.create', {
    kind: 'chat',
    projectId: project.id,
    title: '設計チャット',
    model: 'mock/fast',
  });
  const grant = await call('grant.create', {
    subject: { kind: 'session', sessionId: design.id },
    permissions: [
      'task.*',
      'session.*',
      'workspace.*',
      'artifact.*',
      'integration.create',
      'integration.run',
      'integration.get',
      'integration.list',
      'run.get',
      'run.list',
      'project.get',
      'grant.create',
      'budget.*',
      'events.list',
    ],
    scope: { projectIds: [project.id] },
    limits: { maxWorkers: 2, maxDepth: 1 },
    lifetime: 'session',
    expiresAt: new Date(Date.now() + 8 * 3600_000).toISOString(),
    reason: 'scene',
  });
  await call('budget.allocate', {
    parentId: null,
    subject: { kind: 'session', id: design.id },
    limitUsd: 5,
  });
  const sent = await call('session.send', {
    sessionId: design.id,
    content: '認証まわりのドキュメントとテストを並列で整備して',
  });
  await daemon.ctx.service('runs').waitForEnd(sent.runId!);
  // The orchestrator plans: tasks are created by the chat's agent actor through the same
  // dispatcher (the grant is checked). Falls back to the human if the policy refuses.
  const orchestrator: Actor = { kind: 'agent', sessionId: design.id, runId: sent.runId! };
  const createTask = async (p: ParamsInput<'task.create'>) => {
    try {
      return await call('task.create', p, orchestrator);
    } catch {
      return call('task.create', p);
    }
  };
  const tDocs = await createTask({
    projectId: project.id,
    title: '認証 API のドキュメントを書く',
    description: 'docs/auth.md に、ログイン・トークン更新・ログアウトの API を説明する。',
    acceptanceCriteria: ['3 つのエンドポイントが説明されている', 'エラー時の応答が書かれている'],
  });
  const tTests = await createTask({
    projectId: project.id,
    title: '認証のテストを追加する',
    description: 'isExpired の境界値（ちょうど期限）をテストする。',
    acceptanceCriteria: ['境界値のテストがある', 'pnpm test が通る'],
  });
  await createTask({
    projectId: project.id,
    title: 'README に認証の節を追加する',
    description: 'ドキュメントへのリンクを README に足す。',
    dependsOn: [tDocs.id],
  });
  daemon.ctx.bus.emit({
    type: 'orchestrator.decision',
    actor: orchestrator,
    payload: {
      decision: 'Task を 3 つに分割し、2 つを並列で進めます',
      rationale:
        'ドキュメントとテストは互いに独立しており、README はドキュメントの完成後に着手できるため',
      refs: { taskIds: [tDocs.id, tTests.id] },
    },
    refs: { sessionId: design.id, runId: sent.runId, projectId: project.id },
  });
  void grant;

  // ---------------------------------------------------------------- workers (mock runtime)
  const worker = async (taskId: string, title: string, label: string, message: string) => {
    const ws = await call('workspace.create', { projectId: project.id, taskId, label });
    const s = await call('session.create', {
      kind: 'agent',
      projectId: project.id,
      taskId,
      workspaceId: ws.id,
      title,
      runtime: 'mock',
      parentSessionId: design.id,
      model: 'anthropic/claude-sonnet-4-5',
    });
    await call('task.update', { taskId, assigneeSessionId: s.id, status: 'running' });
    const r = await call('session.send', { sessionId: s.id, content: message });
    return { ws, session: s, runId: r.runId };
  };

  const docs = await worker(
    tDocs.id,
    '認証 API のドキュメント',
    'docs-auth',
    `認証 API のドキュメントを書いてください。${plan(
      [
        { type: 'say', text: '既存の認証コードを確認してから、docs/auth.md を作成します。' },
        {
          type: 'write',
          path: 'docs/auth.md',
          content: [
            '# 認証 API',
            '',
            '## POST /api/login',
            '',
            'メールアドレスとパスワードでログインし、セッショントークンを返します。',
            '',
            '## POST /api/session/refresh',
            '',
            '期限の 60 秒前から更新できます。期限切れの場合は `401` を返します。',
            '',
            '## POST /api/logout',
            '',
            'セッションを無効にします。',
            '',
          ].join('\n'),
        },
        { type: 'check', path: 'docs/auth.md', contains: '/api/login' },
      ],
      'docs/auth.md に 3 つのエンドポイントを説明しました。',
    )}`,
  );
  await daemon.ctx.service('runs').waitForEnd(docs.runId!);
  await call('task.update', {
    taskId: tDocs.id,
    status: 'review',
    resultSummary: 'docs/auth.md に 3 つのエンドポイントを説明しました。',
  });

  const tests = await worker(
    tTests.id,
    '認証のテスト',
    'tests-auth',
    `isExpired の境界値テストを追加してください。${plan(
      [
        { type: 'say', text: '境界値（ちょうど期限の時刻）のテストを追加します。' },
        {
          type: 'write',
          path: 'src/auth/session.test.ts',
          content: [
            "import { describe, expect, it } from 'vitest';",
            "import { isExpired } from './session';",
            '',
            "describe('isExpired', () => {",
            "  it('is false exactly at the expiry time', () => {",
            '    const now = Date.now();',
            "    expect(isExpired({ userId: 'u', expiresAt: now + 1000 })).toBe(false);",
            '  });',
            '});',
            '',
          ].join('\n'),
        },
        { type: 'run', command: 'node', args: ['scripts/test.js'], title: 'テストを実行' },
      ],
      '境界値テストを追加し、テストが通ることを確認しました。',
    )}`,
  );
  // tests now waits for the approval of its `node scripts/test.js` command.
  await until(
    async () =>
      (await call('approval.list', { status: ['pending'], runId: tests.runId! })).items[0],
  );

  // A worker that failed (an attention card with the error).
  const flakyWs = await call('workspace.create', { projectId: project.id, label: 'e2e-flaky' });
  const flaky = await call('session.create', {
    kind: 'agent',
    projectId: project.id,
    workspaceId: flakyWs.id,
    title: 'E2E テストの安定化',
    runtime: 'mock',
  });
  const flakyRun = await call('session.send', {
    sessionId: flaky.id,
    content: `E2E テストを安定させてください。${plan([
      { type: 'say', text: 'ログイン画面の E2E テストを確認します。' },
      {
        type: 'fail',
        message:
          'テストが 3 件失敗しました: LoginForm.test.tsx\nExpected "ログイン" but received "Sign in"',
      },
    ])}`,
  });
  await daemon.ctx
    .service('runs')
    .waitForEnd(flakyRun.runId!)
    .catch(() => undefined);

  // Everyday chats.
  for (const [title, text] of [
    ['週次レポートの下書き', '今週の進捗を 3 行でまとめて'],
    ['レビュー観点の整理', 'コードレビューで見るべき観点を挙げて'],
  ] as const) {
    const s = await call('session.create', {
      kind: 'chat',
      projectId: project.id,
      title,
      model: 'mock/fast',
    });
    const r = await call('session.send', { sessionId: s.id, content: text });
    await daemon.ctx.service('runs').waitForEnd(r.runId!);
  }

  // ---------------------------------------------------------------- integration (really merged + tested)
  const integ = await call('integration.create', { projectId: project.id, taskIds: [tDocs.id] });
  await call('integration.run', { integrationId: integ.id });
  await until(async () => {
    const i = await call('integration.get', { integrationId: integ.id });
    return ['awaiting_approval', 'failed', 'conflict'].includes(i.status) ? i : null;
  }, 60_000);

  // ---------------------------------------------------------------- optional load
  const load = Number(arg('load') ?? 0);
  if (load > 0) {
    const long = Array.from(
      { length: 40 },
      (_, i) =>
        `段落 ${i + 1}: 並列で動くエージェントの出力を、滑らかに描画できるかを確かめるための長めの文章です。`,
    ).join('\n\n');
    for (let i = 0; i < load; i++) {
      const s = await call('session.create', {
        kind: 'chat',
        projectId: project.id,
        title: `負荷確認 ${i + 1}`,
        model: 'mock/echo',
      });
      await call('session.send', { sessionId: s.id, content: long });
    }
    console.log(`load: ${load} streaming chats started`);
  }

  console.log('scene ready (Ctrl+C to stop)');
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
