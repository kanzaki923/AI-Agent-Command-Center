// A code conversation leading children (orchestrator/grant.ts ensureLeadGrant) on the real
// Claude Code: a daemon in a temp ACC_HOME, a small git repository as the project, one agent
// conversation in a worktree asked for three independent pieces at once. Claude Code runs on
// the local login (no key is handed over). Prints what happens: children, wakes, integration,
// cost. The temp folders are kept for a look afterwards.
//
//   pnpm --filter @acc/daemon exec tsx scripts/real-lead.ts [model]
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Actor } from '@acc/protocol';
import { silentLogger } from '../src/core/log';
import { startDaemon } from '../src/daemon';

const MODEL = process.argv[2] ?? 'claude-sonnet-5-5';
const HUMAN: Actor = { kind: 'human', client: 'real-check' };
const TIMEOUT_MS = 20 * 60_000;

const home = mkdtempSync(join(tmpdir(), 'acc-real-lead-'));
const repo = `${home}-repo`;
mkdirSync(join(repo, 'src'), { recursive: true });
const files: Record<string, string> = {
  'package.json': JSON.stringify(
    { name: 'tiny', version: '0.0.0', type: 'module', scripts: { test: 'node --test' } },
    null,
    2,
  ),
  'README.md': '# tiny\n\n小さなユーティリティ集。\n',
  'src/math.js': '// TODO: add(a, b) と clamp(x, min, max) を実装する\n',
  'src/text.js': '// TODO: capitalize(s) と slugify(s) を実装する\n',
  'src/date.js': '// TODO: isoDate(d) を実装する（YYYY-MM-DD）\n',
};
for (const [f, c] of Object.entries(files)) writeFileSync(join(repo, f), c);
const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, stdio: 'pipe' });
git('init', '-q', '-b', 'main');
git('config', 'user.name', 'Real Check');
git('config', 'user.email', 'real-check@example.invalid');
git('config', 'commit.gpgsign', 'false');
git('add', '-A');
git('commit', '-q', '-m', 'init');

const log = (s: string) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${s}`);
log(`ACC_HOME ${home}`);
log(`repo ${repo}`);

const daemon = await startDaemon({ home, log: silentLogger, port: 0, env: {} });
const call = daemon.call.bind(daemon);
const { ctx } = daemon;
try {
  await call(HUMAN, 'settings.update', {
    defaultRuntime: 'claude-agent-sdk',
    limits: { dailyUsd: 5 },
  });
  const project = await call(HUMAN, 'project.create', {
    name: 'tiny',
    repoPath: repo,
    testCommand: 'node --test',
  });
  const lead = await call(HUMAN, 'session.create', {
    kind: 'agent',
    title: 'tiny の実装',
    projectId: project.id,
    model: MODEL,
    workspace: { kind: 'worktree', projectId: project.id },
  });
  await call(HUMAN, 'session.send', {
    sessionId: lead.id,
    content: [
      {
        type: 'text',
        text: [
          '次の3つは独立しているので、並列で進めて。それぞれ node:test のテストも付けて。',
          '1. src/math.js に add と clamp',
          '2. src/text.js に capitalize と slugify',
          '3. src/date.js に isoDate',
          '終わったらまとめて取り込める状態にして。',
        ].join('\n'),
      },
    ],
  });

  const seen = new Set<string>();
  const started = Date.now();
  let lastState = '';
  for (;;) {
    const sessions = ctx.repos.sessions.find({ where: { root_session_id: lead.id } });
    for (const s of sessions) {
      if (s.id !== lead.id && !seen.has(s.id)) {
        seen.add(s.id);
        const ws = s.workspaceId ? ctx.repos.workspaces.get(s.workspaceId) : undefined;
        log(`child 「${s.title}」 ${ws?.kind ?? 'no workspace'} ${ws?.branch ?? ''}`);
      }
    }
    for (const r of ctx.repos.runs.find({ where: { session_id: [...sessions.map((s) => s.id)] } })) {
      const key = `${r.id}:${r.status}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const who = r.sessionId === lead.id ? 'lead' : sessions.find((s) => s.id === r.sessionId)?.title;
      log(`run ${who} ${r.trigger} ${r.status}${r.statusReason ? ` (${r.statusReason})` : ''}`);
    }
    for (const i of ctx.repos.integrations.find({ where: { project_id: project.id } })) {
      const key = `${i.id}:${i.status}`;
      if (seen.has(key)) continue;
      seen.add(key);
      log(`integration ${i.status} tasks=${i.taskIds.length} merges=${i.steps.filter((s) => s.kind === 'merge').length}`);
    }
    for (const m of ctx.repos.messages.find({ where: { session_id: lead.id }, orderBy: 'id' })) {
      if (seen.has(m.id) || m.role === 'user') continue;
      const text = m.content
        .map((p) =>
          p.type === 'text'
            ? p.text
            : p.type === 'tool_call'
              ? `<${p.name}>`
              : '',
        )
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim();
      if (!text) continue;
      seen.add(m.id);
      log(`lead ${m.role}: ${text.slice(0, 300)}`);
    }
    const leadNow = ctx.repos.sessions.require(lead.id);
    const busy = ctx.repos.runs.count({
      where: { session_id: [...sessions.map((s) => s.id)], status: ['queued', 'starting', 'running', 'waiting_approval'] },
    });
    const state = `${leadNow.supervision ?? '-'} busy=${busy}`;
    if (state !== lastState) log(`state ${state}`);
    lastState = state;
    const settled = busy === 0 && seen.size > 3 && Date.now() - started > 30_000;
    const integrated = ctx.repos.integrations
      .find({ where: { project_id: project.id } })
      .some((i) => ['awaiting_approval', 'applied', 'failed', 'conflict'].includes(i.status));
    if ((settled && integrated) || Date.now() - started > TIMEOUT_MS) break;
    if (settled && Date.now() - started > 10 * 60_000) break;
    await new Promise((r) => setTimeout(r, 3000));
  }
  const cost = await call(HUMAN, 'cost.summary', {}).catch(() => null);
  log(`cost ${JSON.stringify(cost)?.slice(0, 400)}`);
  log(`children ${[...seen].filter((k) => k.startsWith('ses')).length}`);
} finally {
  await daemon.close();
}
