import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Actor, Params, Project, Result, Session } from '@acc/protocol';
import type { DaemonContext } from '../core/context';
import { invalidParams } from '../core/errors';
import { git } from '../workspace/git';
import { grantOrchestration } from './grant';
import { MOCK_ORCHESTRATOR_MODEL } from './mockModel';

export const DEMO_SESSION_TITLE = 'デモ: 設計チャット';
export const DEMO_TEST_COMMAND = 'node --test';

/** Identity of the demo repository's initial commit (never the user's git config). */
const DEMO_IDENTITY = {
  GIT_AUTHOR_NAME: 'AI Agent Command Center',
  GIT_AUTHOR_EMAIL: 'acc@localhost',
  GIT_COMMITTER_NAME: 'AI Agent Command Center',
  GIT_COMMITTER_EMAIL: 'acc@localhost',
};

/** Files of the tiny Node project the demo works on (its tests pass with `node --test`). */
export const DEMO_FILES: Record<string, string> = {
  'README.md': [
    '# 認証デモ',
    '',
    'AI Agent Command Center のデモ用の小さな Node.js プロジェクトです。',
    'Orchestrator がこのリポジトリの作業を Task に分け、Worker が別々の worktree で並列に進めます。',
    '',
    '- `src/auth.js`: トークンの発行と検証',
    '- `test/`: `node --test` で実行するテスト',
    '',
    '## リンク',
    '',
  ].join('\n'),
  'package.json': `${JSON.stringify(
    {
      name: 'acc-auth-demo',
      version: '0.1.0',
      private: true,
      description: 'Demo project for AI Agent Command Center',
      scripts: { test: DEMO_TEST_COMMAND },
    },
    null,
    2,
  )}\n`,
  'src/auth.js': [
    "const { randomBytes } = require('node:crypto');",
    '',
    '/** Issue a token like "tok_<16 hex chars>". */',
    'function issueToken() {',
    "  return `tok_${randomBytes(8).toString('hex')}`;",
    '}',
    '',
    'function isToken(value) {',
    "  return typeof value === 'string' && /^tok_[a-z0-9]{8,}$/.test(value);",
    '}',
    '',
    'module.exports = { issueToken, isToken };',
    '',
  ].join('\n'),
  'test/auth-basic.test.js': [
    "const test = require('node:test');",
    "const assert = require('node:assert/strict');",
    "const { issueToken, isToken } = require('../src/auth.js');",
    '',
    "test('issueToken returns a valid token', () => {",
    '  assert.equal(isToken(issueToken()), true);',
    '});',
    '',
  ].join('\n'),
  '.gitignore': 'node_modules/\n',
};

export const DEMO_GOAL_HINT = '認証まわりのドキュメントとテストを並列で整備して';

/**
 * system.setupDemo (idempotent): `<ACC_HOME>/demo/<name>` git repository with a passing
 * test suite, a project for it, and the "デモ: 設計チャット" chat session on
 * `mock/orchestrator` holding the orchestrator grant (session lifetime). Everything that
 * already exists is reused, so the UI can call it on every "デモモードで試す".
 */
export async function setupDemo(
  ctx: DaemonContext,
  p: Params<'system.setupDemo'>,
  actor: Actor,
): Promise<Result<'system.setupDemo'>> {
  const repoPath = join(ctx.paths.home, 'demo', p.name);
  let created = await ensureDemoRepo(repoPath);

  let project = findProject(ctx, repoPath);
  if (!project) {
    project = await ctx.call(actor, 'project.create', {
      name: 'デモプロジェクト（認証）',
      description:
        'デモモード用の小さな Node.js プロジェクト。組み込みの模擬モデルで動き、費用はかかりません。',
      repoPath,
      defaultBranch: 'main',
      testCommand: DEMO_TEST_COMMAND,
    });
    created = true;
  }

  let session = findSession(ctx, project.id);
  if (!session) {
    session = await ctx.call(actor, 'session.create', {
      projectId: project.id,
      kind: 'chat',
      title: DEMO_SESSION_TITLE,
      model: MOCK_ORCHESTRATOR_MODEL,
    });
    created = true;
  }

  const policy = ctx.service('policy');
  let grant = policy
    .sessionGrantsAllowing(session.id, 'task.spawnWorker')
    .find((g) => g.scope.projectIds?.includes(project.id));
  if (!grant) {
    grant = grantOrchestration(
      ctx,
      { sessionId: session.id, projectId: project.id, maxWorkers: 2, lifetime: 'session' },
      actor,
    ).grant;
    created = true;
  }
  return { project, session, grant, repoPath, created };
}

async function ensureDemoRepo(repoPath: string): Promise<boolean> {
  if (existsSync(repoPath)) {
    if (existsSync(join(repoPath, '.git'))) return false;
    throw invalidParams(`デモ用のフォルダが git リポジトリではありません: ${repoPath}`);
  }
  mkdirSync(repoPath, { recursive: true });
  for (const [file, content] of Object.entries(DEMO_FILES)) {
    const full = join(repoPath, file);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content, 'utf8');
  }
  try {
    await git(repoPath, ['init', '-q', '-b', 'main']);
    await git(repoPath, ['config', 'core.autocrlf', 'false']);
    await git(repoPath, ['add', '-A']);
    await git(
      repoPath,
      ['-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'Initial demo project'],
      {
        env: DEMO_IDENTITY,
      },
    );
  } catch (err) {
    throw invalidParams(
      `デモ用のリポジトリを作成できませんでした（git が必要です）: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  return true;
}

function findProject(ctx: DaemonContext, repoPath: string): Project | undefined {
  return ctx.repos.projects
    .find({ where: { archived_at: null }, direction: 'asc' })
    .find((p) => p.repoPath === repoPath);
}

function findSession(ctx: DaemonContext, projectId: string): Session | undefined {
  return ctx.repos.sessions
    .find({ where: { project_id: projectId, kind: 'chat', archived_at: null }, direction: 'asc' })
    .find((s) => s.title === DEMO_SESSION_TITLE);
}
