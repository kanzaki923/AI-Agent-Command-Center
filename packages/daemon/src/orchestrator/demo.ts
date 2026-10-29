import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Actor, Params, Project, Result, Session } from '@acc/protocol';
import type { DaemonContext } from '../core/context';
import { ApiError } from '../core/errors';
import { delegateSession, supervisorGrantsOf } from './grant';
import { MOCK_ORCHESTRATOR_MODEL } from './mockModel';

export const DEMO_SESSION_TITLE = 'デモ: 新製品ローンチ準備';
export const DEMO_PROJECT_NAME = 'デモプロジェクト（新製品ローンチ）';
export const DEMO_SCHEDULE_TITLE = '週次レポート';
/** Mondays 9:00 in the configured time zone. */
export const DEMO_SCHEDULE_CRON = '0 9 * * 1';

/** The first message the demo suggests (one click sends it). */
export const DEMO_GOAL_HINT = '新製品のローンチ準備を進めて。競合の価格調査、FAQ、告知文をお願い';

/** Files of the demo folder (no git: the demo is about leading agents, not code). */
export const LAUNCH_DEMO_FILES: Record<string, string> = {
  'brief.md': [
    '# 新製品ローンチの概要',
    '',
    '- 製品: 家計簿アプリ「Kakei」',
    '- 価格案: 月額 980 円（初月無料）',
    '- 発売日: 来月 1 日',
    '- 伝えたいこと: 入力が速い、銀行と連携できる、家族で共有できる',
    '',
  ].join('\n'),
};

/**
 * system.setupDemo (idempotent; spec 20261029 §3.13): a folder `<ACC_HOME>/demo/<name>`
 * with the product brief (no git), a project for it, and the "デモ: 新製品ローンチ準備" chat on
 * `mock/orchestrator` that leads children (session.delegate, session lifetime), plus a weekly
 * report schedule when schedules are available. Everything that already exists is reused,
 * so the UI can call it on every "デモモードで試す". `repoPath` in the result is the folder.
 */
export async function setupDemo(
  ctx: DaemonContext,
  p: Params<'system.setupDemo'>,
  actor: Actor,
): Promise<Result<'system.setupDemo'>> {
  const folder = join(ctx.paths.home, 'demo', p.name);
  let created = ensureDemoFolder(folder);

  let project = findProject(ctx, folder);
  if (!project) {
    project = await ctx.call(actor, 'project.create', {
      name: DEMO_PROJECT_NAME,
      description: 'デモモード用のフォルダ。組み込みの模擬モデルで動き、費用はかかりません。',
      folderPath: folder,
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

  let grant = supervisorGrantsOf(ctx, session.id)[0];
  if (!grant) {
    grant = delegateSession(
      ctx,
      {
        sessionId: session.id,
        maxChildren: 4,
        budgetUsd: 3,
        projectId: project.id,
        allowSchedules: true,
        lifetime: 'session',
      },
      actor,
    ).grant;
    created = true;
  }
  if (await ensureWeeklyReport(ctx, session, actor)) created = true;
  return { project, session, grant, repoPath: folder, created };
}

function ensureDemoFolder(folder: string): boolean {
  let created = false;
  if (!existsSync(folder)) {
    mkdirSync(folder, { recursive: true });
    created = true;
  }
  for (const [file, content] of Object.entries(LAUNCH_DEMO_FILES)) {
    const full = join(folder, file);
    if (existsSync(full)) continue;
    writeFileSync(full, content, 'utf8');
    created = true;
  }
  return created;
}

/** The demo's weekly report (skipped while schedules are not available). */
async function ensureWeeklyReport(
  ctx: DaemonContext,
  session: Session,
  actor: Actor,
): Promise<boolean> {
  if (!ctx.methods.has('schedule.create') || !ctx.methods.has('schedule.list')) return false;
  try {
    const existing = await ctx.call(actor, 'schedule.list', { sessionId: session.id });
    if (existing.items.some((s) => s.title === DEMO_SCHEDULE_TITLE)) return false;
    await ctx.call(actor, 'schedule.create', {
      sessionId: session.id,
      title: DEMO_SCHEDULE_TITLE,
      prompt: '今週の進み具合を 1 ページのレポートにまとめて',
      trigger: { kind: 'cron', expr: DEMO_SCHEDULE_CRON },
    });
    return true;
  } catch (err) {
    if (err instanceof ApiError && err.code === 'not_found') return false;
    throw err;
  }
}

/**
 * A tiny Node project with passing `node --test` tests: the earlier code demo, kept as a
 * fixture for scene scripts (apps/desktop/scripts) that build code projects.
 */
export const DEMO_FILES: Record<string, string> = {
  'README.md': [
    '# 認証デモ',
    '',
    'AI Agent Command Center のデモ用の小さな Node.js プロジェクトです。',
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
      scripts: { test: 'node --test' },
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

function findProject(ctx: DaemonContext, folder: string): Project | undefined {
  return ctx.repos.projects
    .find({ where: { archived_at: null }, direction: 'asc' })
    .find((p) => p.folderPath === folder);
}

function findSession(ctx: DaemonContext, projectId: string): Session | undefined {
  return ctx.repos.sessions
    .find({ where: { project_id: projectId, kind: 'chat', archived_at: null }, direction: 'asc' })
    .find((s) => s.title === DEMO_SESSION_TITLE);
}
