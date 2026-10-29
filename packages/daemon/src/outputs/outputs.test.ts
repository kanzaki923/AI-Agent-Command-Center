/**
 * T3 acceptance (spec 20261029 §5.5) without git: artifact.publish of the four kinds (limits,
 * paths outside the workspace), artifact.read (paging, truncation), finalize in a folder
 * workspace (published > tracked writes > final answer), legacy note / file rows, and the
 * artifact.list filters. Code changes and their integration are in code.test.ts.
 */
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type AgentActor,
  type Artifact,
  EMPTY_USAGE,
  OUTPUT_LIMITS,
  type Run,
  type Session,
  type Workspace,
} from '@acc/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { ApiError } from '../core/errors';
import { HUMAN, type TestDaemonNoServer, agentActor, createTestDaemon } from '../testing';
import { parseCsv, toCsv } from './csv';
import { asCurrentKind } from './legacy';
import { commonFolder } from './paths';
import { page } from './read';

const daemons: TestDaemonNoServer[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const d of daemons.splice(0)) await d.cleanup();
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

async function daemon(): Promise<TestDaemonNoServer> {
  const d = await createTestDaemon();
  daemons.push(d);
  d.ctx.service('llm').mock.chunkDelayMs = 0;
  return d;
}

function tempDir(files: Record<string, string> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), 'acc-outputs-'));
  dirs.push(dir);
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(join(dir, rel, '..'), { recursive: true });
    writeFileSync(join(dir, rel), content);
  }
  return dir;
}

async function codeOf(p: Promise<unknown>): Promise<string> {
  return p.then(
    () => 'ok',
    (e: unknown) => (e instanceof ApiError ? e.code : String(e)),
  );
}

interface Agent {
  dir: string;
  ws: Workspace;
  parent: Session;
  session: Session;
  run: Run;
  actor: AgentActor;
}

/**
 * A child agent working in a plain folder (kind directory, no project): its run holds a grant
 * for the outputs methods, as a spawned child's default grant does.
 */
async function folderAgent(d: TestDaemonNoServer, files: Record<string, string>): Promise<Agent> {
  const dir = tempDir(files);
  const now = d.ctx.clock.iso();
  const ws = d.ctx.repos.workspaces.insert({
    id: d.ctx.ids.next('workspace'),
    projectId: null,
    kind: 'directory',
    status: 'ready',
    path: dir,
    branch: null,
    baseRef: null,
    taskId: null,
    lockedByRunId: null,
    error: null,
    createdAt: now,
    updatedAt: now,
  });
  const parent = await d.call(HUMAN, 'session.create', { title: '新製品ローンチ' });
  const session = await d.call(HUMAN, 'session.create', {
    kind: 'agent',
    title: 'FAQ を書く',
    parentSessionId: parent.id,
  });
  const run = d.ctx.repos.runs.insert({
    id: d.ctx.ids.next('run'),
    sessionId: session.id,
    projectId: null,
    taskId: null,
    kind: 'agent',
    status: 'running',
    statusReason: null,
    model: null,
    runtime: 'mock',
    workspaceId: ws.id,
    parentRunId: null,
    retryOfRunId: null,
    attempt: 1,
    budgetId: null,
    triggerMessageId: null,
    usage: EMPTY_USAGE,
    error: null,
    createdBy: HUMAN,
    createdAt: now,
    updatedAt: now,
    startedAt: now,
    endedAt: null,
  });
  d.ctx.service('policy').createGrant(
    {
      subject: { kind: 'run', runId: run.id },
      permissions: ['artifact.publish', 'artifact.read', 'artifact.list', 'artifact.get'],
      lifetime: 'run',
    },
    HUMAN,
  );
  return { dir, ws, parent, session, run, actor: agentActor(session.id, run.id) };
}

function complete(d: TestDaemonNoServer, run: Run): Run {
  return d.ctx.repos.runs.update(run.id, (r) => ({ ...r, status: 'completed' }));
}

/** A file tool use of the run, as the runtimes report it (tool.called + tool.result). */
function toolUse(d: TestDaemonNoServer, a: Agent, name: string, input: unknown, isError = false) {
  const toolCallId = `call_${Math.random().toString(36).slice(2)}`;
  d.ctx.db.transaction(() => {
    d.ctx.bus.emit({
      type: 'tool.called',
      actor: a.actor,
      payload: { runId: a.run.id, toolCallId, name, input },
    });
    d.ctx.bus.emit({
      type: 'tool.result',
      actor: a.actor,
      payload: { runId: a.run.id, toolCallId, name, output: 'ok', isError, durationMs: null },
    });
  });
}

function say(d: TestDaemonNoServer, a: Agent, text: string): void {
  d.ctx.service('sessions').appendMessage({
    sessionId: a.session.id,
    runId: a.run.id,
    role: 'assistant',
    content: [{ type: 'text', text }],
    author: a.actor,
  });
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

describe('outputs helpers', () => {
  it('parses and writes CSV with quotes, commas, line breaks and a BOM', () => {
    const text = '﻿name,note\r\n"山田, 太郎","say ""hi""\nbye"\nplain,\n';
    expect(parseCsv(text)).toEqual([
      ['name', 'note'],
      ['山田, 太郎', 'say "hi"\nbye'],
      ['plain', ''],
    ]);
    const csv = toCsv(
      ['a', 'b'],
      [
        ['x,y', 'q"'],
        [null, { k: 1 }],
        [3, true],
      ],
    );
    expect(csv).toBe('a,b\n"x,y","q"""\n,"{""k"":1}"\n3,true\n');
    expect(parseCsv(csv)[1]).toEqual(['x,y', 'q"']);
  });

  it('pages UTF-8 text without cutting a character', () => {
    const buf = Buffer.from('あいう', 'utf8'); // 3 bytes each
    expect(page(buf, 0, 4, null)).toEqual({ content: 'あ', mimeType: null, truncated: true });
    expect(page(buf, 1, 6, null).content).toBe('いう'); // offset inside あ → starts at い
    expect(page(buf, 3, 64, 'text/plain')).toEqual({
      content: 'いう',
      mimeType: 'text/plain',
      truncated: false,
    });
    expect(page(buf, 99, 10, null)).toEqual({ content: '', mimeType: null, truncated: false });
  });

  it('finds the common folder of workspace paths', () => {
    expect(commonFolder(['docs/a.md', 'docs/sub/b.md'])).toBe('docs');
    expect(commonFolder(['docs/a.md', 'src/b.ts'])).toBe('');
    expect(commonFolder(['a.md'])).toBe('');
    expect(commonFolder(['x/y/z.md'])).toBe('x/y');
  });
});

// ---------------------------------------------------------------------------
// acceptance 1: artifact.publish and artifact.read
// ---------------------------------------------------------------------------

describe('artifact.publish', () => {
  it('publishes a document from text or from a workspace file, as the run’s output', async () => {
    const d = await daemon();
    const a = await folderAgent(d, { 'faq.md': '# FAQ\n\n価格は月額 980 円です。\n' });
    const doc = await d.call(a.actor, 'artifact.publish', {
      kind: 'document',
      title: 'FAQ',
      summary: '  よくある質問\n10 件 ',
      content: '# FAQ',
    });
    expect(doc).toMatchObject({
      kind: 'document',
      role: 'output',
      source: 'published',
      summary: 'よくある質問 10 件',
      sessionId: a.session.id,
      runId: a.run.id,
      workspaceId: a.ws.id,
      review: { state: 'none' },
      data: { format: 'markdown', content: '# FAQ', path: null },
    });
    const fromFile = await d.call(a.actor, 'artifact.publish', {
      kind: 'document',
      title: 'FAQ（ファイル）',
      path: 'faq.md',
    });
    expect(fromFile.data).toEqual({
      format: 'markdown',
      content: '# FAQ\n\n価格は月額 980 円です。\n',
      path: 'faq.md',
    });
    // Absolute paths inside the workspace work too.
    const abs = await d.call(a.actor, 'artifact.publish', {
      kind: 'document',
      title: 'abs',
      path: join(a.dir, 'faq.md'),
      format: 'text',
    });
    expect(abs.data).toMatchObject({ format: 'text', path: 'faq.md' });
    const created = d.ctx.bus.list({ types: ['artifact.created'] }).events;
    expect(created).toHaveLength(3);
  });

  it('refuses paths outside the workspace, in .git, missing files and bad combinations', async () => {
    const d = await daemon();
    const outside = tempDir({ 'secret.md': 'x' });
    const a = await folderAgent(d, { 'ok.md': 'ok', '.git/config': '[core]' });
    const publish = (p: Record<string, unknown>) =>
      codeOf(d.call(a.actor, 'artifact.publish', { kind: 'document', title: 't', ...p }));
    expect(await publish({ path: join(outside, 'secret.md') })).toBe('invalid_params');
    expect(await publish({ path: '../secret.md' })).toBe('invalid_params');
    expect(await publish({ path: '~/secret.md' })).toBe('invalid_params');
    expect(await publish({ path: '.git/config' })).toBe('invalid_params');
    expect(await publish({ path: 'missing.md' })).toBe('invalid_params');
    expect(await publish({ path: 'ok.md', content: 'both' })).toBe('invalid_params');
    expect(await publish({})).toBe('invalid_params');
    expect(await publish({ content: 'x', format: 'html' })).toBe('invalid_params');
    expect(await publish({ path: '.' })).toBe('invalid_params'); // a folder
    // The message tells the agent why.
    await expect(
      d.call(a.actor, 'artifact.publish', { kind: 'document', title: 't', path: '../x' }),
    ).rejects.toThrow(/作業場所の外/);
    expect(
      await codeOf(
        d.call(a.actor, 'artifact.publish', { kind: 'files', title: 't', paths: [outside] }),
      ),
    ).toBe('invalid_params');
  });

  it('enforces the size limits (document 1 MB, data 5,000 rows / 2 MB, 500 files)', async () => {
    const d = await daemon();
    const a = await folderAgent(d, {
      'big.md': 'x'.repeat(OUTPUT_LIMITS.documentChars + 1),
      'rows.csv': [
        'n',
        ...Array.from({ length: OUTPUT_LIMITS.dataRows + 1 }, (_, i) => `${i}`),
      ].join('\n'),
      // The file fits (2 MB) but the table it makes does not.
      'wide.json': JSON.stringify([{ v: 'y'.repeat(OUTPUT_LIMITS.dataBytes - 15) }]),
    });
    for (let i = 0; i <= OUTPUT_LIMITS.files; i++) {
      mkdirSync(join(a.dir, 'many'), { recursive: true });
      writeFileSync(join(a.dir, 'many', `f${String(i).padStart(3, '0')}.txt`), 'x');
    }
    const publish = (p: Record<string, unknown>) =>
      codeOf(d.call(a.actor, 'artifact.publish', { title: 't', ...p } as never));
    expect(await publish({ kind: 'document', path: 'big.md' })).toBe('invalid_params');
    expect(
      await publish({ kind: 'document', content: 'x'.repeat(OUTPUT_LIMITS.documentChars + 1) }),
    ).toBe('invalid_params');
    expect(await publish({ kind: 'data', path: 'rows.csv' })).toBe('invalid_params');
    expect(
      await publish({
        kind: 'data',
        columns: ['n'],
        rows: Array.from({ length: OUTPUT_LIMITS.dataRows + 1 }, (_, i) => [i]),
      }),
    ).toBe('invalid_params');
    expect(await publish({ kind: 'data', path: 'wide.json' })).toBe('invalid_params');
    expect(await publish({ kind: 'files', paths: ['many'] })).toBe('invalid_params');
    // Right at the limit is fine.
    expect(
      await publish({
        kind: 'data',
        columns: ['n'],
        rows: Array.from({ length: OUTPUT_LIMITS.dataRows }, (_, i) => [i]),
      }),
    ).toBe('ok');
    unlinkSync(join(a.dir, 'many', 'f000.txt'));
    expect(await publish({ kind: 'files', paths: ['many'] })).toBe('ok');
  });

  it('publishes data inline, from CSV and from JSON', async () => {
    const d = await daemon();
    const a = await folderAgent(d, {
      'prices.csv': 'plan,usd\nbasic,9.8\n"pro, yearly",98\n',
      'prices.json': JSON.stringify([
        { plan: 'basic', usd: 9.8 },
        { plan: 'pro', note: 'new' },
      ]),
      'matrix.json': JSON.stringify([
        ['a', 'b'],
        [1, 2],
      ]),
    });
    const inline = await d.call(a.actor, 'artifact.publish', {
      kind: 'data',
      title: '価格表',
      columns: ['plan', 'usd'],
      rows: [['basic', 9.8], ['pro']],
    });
    expect(inline.data).toEqual({
      format: 'json',
      columns: ['plan', 'usd'],
      rows: [
        ['basic', 9.8],
        ['pro', null],
      ],
      path: null,
    });
    const csv = await d.call(a.actor, 'artifact.publish', {
      kind: 'data',
      title: 'csv',
      path: 'prices.csv',
    });
    expect(csv.data).toEqual({
      format: 'csv',
      columns: ['plan', 'usd'],
      rows: [
        ['basic', '9.8'],
        ['pro, yearly', '98'],
      ],
      path: 'prices.csv',
    });
    const json = await d.call(a.actor, 'artifact.publish', {
      kind: 'data',
      title: 'json',
      path: 'prices.json',
    });
    expect(json.data).toMatchObject({
      format: 'json',
      columns: ['plan', 'usd', 'note'],
      rows: [
        ['basic', 9.8, null],
        ['pro', null, 'new'],
      ],
    });
    const matrix = await d.call(a.actor, 'artifact.publish', {
      kind: 'data',
      title: 'm',
      path: 'matrix.json',
    });
    expect(matrix.data).toMatchObject({ columns: ['a', 'b'], rows: [[1, 2]] });
    expect(
      await codeOf(
        d.call(a.actor, 'artifact.publish', {
          kind: 'data',
          title: 'x',
          columns: ['a'],
          rows: [[1, 2]],
        }),
      ),
    ).toBe('invalid_params');
  });

  it('publishes http(s) links only, and files with their sizes and types', async () => {
    const d = await daemon();
    const a = await folderAgent(d, {
      'docs/a.md': '# A',
      'docs/sub/b.txt': 'bee',
      'docs/.git/HEAD': 'x',
      'logo.png': 'png',
    });
    const link = await d.call(a.actor, 'artifact.publish', {
      kind: 'link',
      title: '競合の価格ページ',
      url: ' https://example.com/pricing ',
    });
    expect(link.data).toEqual({ url: 'https://example.com/pricing', label: null });
    for (const url of ['javascript:alert(1)', 'file:///etc/passwd', 'not a url']) {
      expect(
        await codeOf(d.call(a.actor, 'artifact.publish', { kind: 'link', title: 'x', url })),
        url,
      ).toBe('invalid_params');
    }
    const files = await d.call(a.actor, 'artifact.publish', {
      kind: 'files',
      title: '原稿',
      paths: ['docs', 'docs/a.md'],
    });
    expect(files.data).toEqual({
      root: 'docs',
      files: [
        { path: 'a.md', size: 3, mimeType: 'text/markdown' },
        { path: 'sub/b.txt', size: 3, mimeType: 'text/plain' },
      ],
    });
    const mixed = await d.call(a.actor, 'artifact.publish', {
      kind: 'files',
      title: 'mixed',
      paths: ['logo.png', 'docs/a.md'],
    });
    expect(mixed.data).toEqual({
      root: '',
      files: [
        { path: 'docs/a.md', size: 3, mimeType: 'text/markdown' },
        { path: 'logo.png', size: 3, mimeType: 'image/png' },
      ],
    });
  });

  it('is for agent runs, within their grant', async () => {
    const d = await daemon();
    const a = await folderAgent(d, {});
    expect(
      await codeOf(
        d.call(HUMAN, 'artifact.publish', { kind: 'document', title: 'x', content: 'y' }),
      ),
    ).toBe('invalid_params');
    const stranger = agentActor(a.session.id, d.ctx.ids.next('run'));
    expect(
      await codeOf(
        d.call(stranger, 'artifact.publish', { kind: 'document', title: 'x', content: 'y' }),
      ),
    ).toBe('forbidden');
    // Without a workspace, content still works but paths do not.
    d.ctx.repos.runs.update(a.run.id, (r) => ({ ...r, workspaceId: null }));
    expect(
      await codeOf(
        d.call(a.actor, 'artifact.publish', { kind: 'document', title: 'x', content: 'y' }),
      ),
    ).toBe('ok');
    expect(
      await codeOf(
        d.call(a.actor, 'artifact.publish', { kind: 'files', title: 'x', paths: ['.'] }),
      ),
    ).toBe('invalid_params');
  });
});

describe('artifact.read', () => {
  it('reads documents and data in pages, and says when it truncated', async () => {
    const d = await daemon();
    const a = await folderAgent(d, {});
    const text = `# 告知文\n${'新製品を発表します。'.repeat(20)}`;
    const doc = await d.call(a.actor, 'artifact.publish', {
      kind: 'document',
      title: '告知文',
      content: text,
    });
    expect(await d.call(a.actor, 'artifact.read', { artifactId: doc.id })).toEqual({
      content: text,
      mimeType: 'text/markdown',
      truncated: false,
    });
    let offset = 0;
    let joined = '';
    for (let i = 0; i < 100; i++) {
      const r = await d.call(HUMAN, 'artifact.read', { artifactId: doc.id, offset, limit: 50 });
      joined += r.content;
      offset += Buffer.byteLength(r.content, 'utf8');
      if (!r.truncated) break;
      expect(Buffer.byteLength(r.content, 'utf8')).toBeLessThanOrEqual(50);
    }
    expect(joined).toBe(text);
    expect(
      await codeOf(
        d.call(HUMAN, 'artifact.read', {
          artifactId: doc.id,
          limit: OUTPUT_LIMITS.readMaxBytes + 1,
        }),
      ),
    ).toBe('invalid_params');

    const data = await d.call(a.actor, 'artifact.publish', {
      kind: 'data',
      title: '表',
      columns: ['plan', 'usd'],
      rows: [['basic, monthly', 9.8]],
    });
    expect(await d.call(HUMAN, 'artifact.read', { artifactId: data.id })).toEqual({
      content: 'plan,usd\n"basic, monthly",9.8\n',
      mimeType: 'text/csv',
      truncated: false,
    });
    const link = await d.call(a.actor, 'artifact.publish', {
      kind: 'link',
      title: 'l',
      url: 'https://example.com',
    });
    expect((await d.call(HUMAN, 'artifact.read', { artifactId: link.id })).content).toBe(
      'https://example.com',
    );
  });

  it('reads one file of a files output from the workspace', async () => {
    const d = await daemon();
    const a = await folderAgent(d, { 'out/a.md': 'A の中身', 'out/b.md': 'B', 'bin.dat': '\0\0' });
    const files = await d.call(a.actor, 'artifact.publish', {
      kind: 'files',
      title: '原稿',
      paths: ['out'],
    });
    expect(await d.call(HUMAN, 'artifact.read', { artifactId: files.id, path: 'a.md' })).toEqual({
      content: 'A の中身',
      mimeType: 'text/markdown',
      truncated: false,
    });
    expect(
      (await d.call(HUMAN, 'artifact.read', { artifactId: files.id, path: 'out/b.md' })).content,
    ).toBe('B');
    const r = await d.call(HUMAN, 'artifact.read', {
      artifactId: files.id,
      path: 'a.md',
      limit: 2,
    });
    expect(r).toMatchObject({ content: 'A ', truncated: true });
    // Which file? Not one of them? Gone?
    expect(await codeOf(d.call(HUMAN, 'artifact.read', { artifactId: files.id }))).toBe(
      'invalid_params',
    );
    expect(
      await codeOf(d.call(HUMAN, 'artifact.read', { artifactId: files.id, path: 'c.md' })),
    ).toBe('invalid_params');
    unlinkSync(join(a.dir, 'out', 'b.md'));
    expect(
      await codeOf(d.call(HUMAN, 'artifact.read', { artifactId: files.id, path: 'b.md' })),
    ).toBe('not_found');
    const bin = await d.call(a.actor, 'artifact.publish', {
      kind: 'files',
      title: 'bin',
      paths: ['bin.dat'],
    });
    expect(await codeOf(d.call(HUMAN, 'artifact.read', { artifactId: bin.id }))).toBe(
      'invalid_params',
    );
  });

  it('keeps agents to their own session tree', async () => {
    const d = await daemon();
    const a = await folderAgent(d, {});
    const b = await folderAgent(d, {});
    const doc = await d.call(a.actor, 'artifact.publish', {
      kind: 'document',
      title: 'mine',
      content: 'x',
    });
    expect(await codeOf(d.call(a.actor, 'artifact.read', { artifactId: doc.id }))).toBe('ok');
    expect(await codeOf(d.call(b.actor, 'artifact.read', { artifactId: doc.id }))).toBe(
      'forbidden',
    );
    expect(await codeOf(d.call(b.actor, 'artifact.get', { artifactId: doc.id }))).toBe('forbidden');
    expect(await codeOf(d.call(b.actor, 'artifact.list', { sessionId: a.session.id }))).toBe(
      'forbidden',
    );
  });
});

// ---------------------------------------------------------------------------
// acceptance 2: finalize (folder / scratch, no git)
// ---------------------------------------------------------------------------

describe('outputs.finalize', () => {
  it('keeps published outputs, then the files the run wrote, and no final answer', async () => {
    const d = await daemon();
    const a = await folderAgent(d, {
      'faq.md': '# FAQ',
      'draft/notes.md': 'notes',
      'draft/plan.md': 'plan',
      'denied.md': 'old',
    });
    const outside = tempDir({ 'x.md': 'x' });
    const doc = await d.call(a.actor, 'artifact.publish', {
      kind: 'document',
      title: 'FAQ',
      path: 'faq.md',
    });
    toolUse(d, a, 'Write', { file_path: 'faq.md', content: '# FAQ' }); // published already
    toolUse(d, a, 'Write', { file_path: join(a.dir, 'draft', 'notes.md') });
    toolUse(d, a, 'Edit', { file_path: 'draft/plan.md' });
    toolUse(d, a, 'Edit', { file_path: 'denied.md' }, true); // the gate refused it
    toolUse(d, a, 'Write', { file_path: join(outside, 'x.md') }); // outside: not ours
    toolUse(d, a, 'Write', { file_path: 'gone.md' }); // deleted since
    toolUse(d, a, 'Read', { file_path: 'faq.md' }); // not a write
    say(d, a, '終わりました。');
    const run = complete(d, a.run);

    const res = await d.ctx.service('outputs').finalize(run);
    expect(res.needsReview).toBe(false);
    expect(res.artifactIds).toHaveLength(2);
    expect(res.artifactIds[0]).toBe(doc.id);
    const files = d.ctx.service('artifacts').get(res.artifactIds[1]!);
    expect(files).toMatchObject({
      kind: 'files',
      source: 'tracked_writes',
      role: 'output',
      title: 'notes.md ほか 1 件',
      sessionId: a.session.id,
      runId: a.run.id,
      data: {
        root: 'draft',
        files: [
          { path: 'notes.md', size: 5, mimeType: 'text/markdown' },
          { path: 'plan.md', size: 4, mimeType: 'text/markdown' },
        ],
      },
    });
    // Idempotent: a second call records nothing new.
    expect(await d.ctx.service('outputs').finalize(run)).toEqual(res);
    expect(d.ctx.repos.artifacts.count()).toBe(2);
  });

  it('turns the last answer into a document when nothing else was left', async () => {
    const d = await daemon();
    const a = await folderAgent(d, {});
    say(d, a, '途中経過です。');
    say(d, a, '## 競合調査\n\n3 社を比べました。最安は A 社です。');
    const run = complete(d, a.run);
    const res = await d.ctx.service('outputs').finalize(run);
    expect(res).toMatchObject({ needsReview: false });
    expect(res.artifactIds).toHaveLength(1);
    expect(d.ctx.service('artifacts').get(res.artifactIds[0]!)).toMatchObject({
      kind: 'document',
      source: 'final_message',
      title: 'FAQ を書く',
      summary: '競合調査',
      data: { format: 'markdown', content: '## 競合調査\n\n3 社を比べました。最安は A 社です。' },
    });
    expect(await d.ctx.service('outputs').finalize(run)).toEqual(res);
    expect(d.ctx.repos.artifacts.count()).toBe(1);
  });

  it('asks for a review when the brief says a human reviews, and records nothing for unfinished runs', async () => {
    const d = await daemon();
    const a = await folderAgent(d, {});
    d.ctx.repos.sessions.update(a.session.id, (s) => ({
      ...s,
      brief: {
        goal: 'FAQ',
        doneWhen: [],
        fromSessionId: a.parent.id,
        reviewBy: 'human',
        givenAt: d.ctx.clock.iso(),
      },
    }));
    say(d, a, 'FAQ の案です。');
    // Still running: nothing settled yet.
    expect(await d.ctx.service('outputs').finalize(a.run)).toEqual({
      needsReview: false,
      artifactIds: [],
    });
    const res = await d.ctx.service('outputs').finalize(complete(d, a.run));
    expect(res.needsReview).toBe(true);
    const out = d.ctx.service('artifacts').get(res.artifactIds[0]!);
    expect(out.review.state).toBe('pending');
    expect(d.ctx.bus.list({ types: ['artifact.updated'] }).events.at(-1)).toMatchObject({
      payload: { changes: ['review'], artifact: { id: out.id, review: { state: 'pending' } } },
    });
  });
});

// ---------------------------------------------------------------------------
// accepting / redoing non-code outputs
// ---------------------------------------------------------------------------

describe('artifact.review (non-code)', () => {
  it('a human accepts an output; agents cannot accept; evidence is not reviewable', async () => {
    const d = await daemon();
    const a = await folderAgent(d, {});
    const doc = await d.call(a.actor, 'artifact.publish', {
      kind: 'document',
      title: 'FAQ',
      content: 'x',
    });
    const supervisor = agentActor(a.parent.id, d.ctx.ids.next('run'));
    d.ctx.service('policy').createGrant(
      {
        subject: { kind: 'session', sessionId: a.parent.id },
        permissions: ['artifact.review'],
        lifetime: 'session',
      },
      HUMAN,
    );
    expect(
      await codeOf(
        d.call(supervisor, 'artifact.review', { artifactId: doc.id, decision: 'accept' }),
      ),
    ).toBe('forbidden');
    const res = await d.call(HUMAN, 'artifact.review', {
      artifactId: doc.id,
      decision: 'accept',
      note: 'OK',
    });
    expect(res).toMatchObject({
      integrationId: null,
      artifact: { id: doc.id, review: { state: 'accepted', by: HUMAN, note: 'OK' } },
    });
    // Accepting twice changes nothing.
    await d.call(HUMAN, 'artifact.review', { artifactId: doc.id, decision: 'accept' });
    expect(d.ctx.bus.list({ types: ['artifact.updated'] }).events).toHaveLength(1);

    const evidence = d.ctx.service('artifacts').recordTestResult({
      sessionId: a.session.id,
      command: 'node -v',
      passed: true,
      exitCode: 0,
      durationMs: 1,
      summary: 'ok',
      output: null,
      createdBy: HUMAN,
    });
    expect(
      await codeOf(
        d.call(HUMAN, 'artifact.review', { artifactId: evidence.id, decision: 'accept' }),
      ),
    ).toBe('invalid_params');
  });
});

// ---------------------------------------------------------------------------
// acceptance 5: legacy rows, and the list filters
// ---------------------------------------------------------------------------

describe('legacy artifacts and artifact.list', () => {
  function insertLegacy(d: TestDaemonNoServer, a: Agent): { note: Artifact; file: Artifact } {
    const now = d.ctx.clock.iso();
    const base = {
      projectId: null,
      sessionId: a.session.id,
      runId: a.run.id,
      taskId: null,
      workspaceId: a.ws.id,
      createdBy: HUMAN,
      createdAt: now,
    };
    const note = d.ctx.repos.artifacts.insert({
      ...base,
      id: d.ctx.ids.next('artifact'),
      kind: 'note',
      title: '旧メモ',
      data: { text: '# メモ\n本文' },
    });
    const file = d.ctx.repos.artifacts.insert({
      ...base,
      id: d.ctx.ids.next('artifact'),
      kind: 'file',
      title: '旧ファイル',
      data: { path: 'old.txt', mimeType: 'text/plain', content: 'インライン' },
    });
    return { note, file };
  }

  it('reads old note / file rows as document / files without rewriting them', async () => {
    const d = await daemon();
    const a = await folderAgent(d, { 'disk.txt': 'ディスク' });
    const { note, file } = insertLegacy(d, a);
    expect(await d.call(HUMAN, 'artifact.get', { artifactId: note.id })).toMatchObject({
      kind: 'document',
      role: 'output',
      data: { format: 'markdown', content: '# メモ\n本文', path: null },
    });
    expect(await d.call(HUMAN, 'artifact.get', { artifactId: file.id })).toMatchObject({
      kind: 'files',
      data: { root: '', files: [{ path: 'old.txt', size: 15, mimeType: 'text/plain' }] },
    });
    expect((await d.call(HUMAN, 'artifact.read', { artifactId: note.id })).content).toBe(
      '# メモ\n本文',
    );
    expect(await d.call(HUMAN, 'artifact.read', { artifactId: file.id })).toEqual({
      content: 'インライン',
      mimeType: 'text/plain',
      truncated: false,
    });
    // A legacy file without inline content is read from its workspace.
    const onDisk = d.ctx.repos.artifacts.insert({
      ...(file as Extract<Artifact, { kind: 'file' }>),
      id: d.ctx.ids.next('artifact'),
      data: { path: 'disk.txt', mimeType: null, content: null },
    });
    expect((await d.call(HUMAN, 'artifact.read', { artifactId: onDisk.id })).content).toBe(
      'ディスク',
    );
    // The kind filter finds them under the new names; the rows stay as they were.
    const docs = await d.call(HUMAN, 'artifact.list', { kind: 'document' });
    expect(docs.items.map((x) => x.id)).toEqual([note.id]);
    const files = await d.call(HUMAN, 'artifact.list', { kind: 'files' });
    expect(files.items.map((x) => x.id)).toEqual([onDisk.id, file.id]);
    expect(d.ctx.repos.artifacts.require(note.id).kind).toBe('note');
    expect(asCurrentKind(d.ctx.repos.artifacts.require(file.id)).kind).toBe('files');
  });

  it('filters by role and by session tree', async () => {
    const d = await daemon();
    const a = await folderAgent(d, {});
    const other = await folderAgent(d, {});
    const doc = await d.call(a.actor, 'artifact.publish', {
      kind: 'document',
      title: 'out',
      content: 'x',
    });
    const test = d.ctx.service('artifacts').recordTestResult({
      sessionId: a.session.id,
      command: 'pnpm test',
      passed: true,
      exitCode: 0,
      durationMs: 5,
      summary: 'ok',
      output: 'ok',
      createdBy: HUMAN,
    });
    await d.call(other.actor, 'artifact.publish', { kind: 'link', title: 'l', url: 'https://a.b' });
    // A row written before `role` existed falls back to the kind's default.
    const old = d.ctx.repos.artifacts.insert({
      id: d.ctx.ids.next('artifact'),
      kind: 'commit',
      projectId: null,
      sessionId: a.session.id,
      runId: null,
      taskId: null,
      workspaceId: null,
      title: 'c',
      data: { sha: 'abc', branch: null, message: 'm', stats: null },
      createdBy: HUMAN,
      createdAt: d.ctx.clock.iso(),
    });
    d.ctx.db.run("UPDATE artifacts SET data = json_remove(data, '$.role') WHERE id = ?", [old.id]);

    const ids = async (p: Record<string, unknown>) =>
      (await d.call(HUMAN, 'artifact.list', p)).items.map((x) => x.id);
    expect(await ids({ rootSessionId: a.parent.id })).toEqual([old.id, test.id, doc.id]);
    expect(await ids({ rootSessionId: a.parent.id, role: 'output' })).toEqual([doc.id]);
    expect(await ids({ rootSessionId: a.parent.id, role: 'evidence' })).toEqual([old.id, test.id]);
    // The child itself may list its own tree; the requester's tree is outside it.
    expect(await codeOf(d.call(a.actor, 'artifact.list', { sessionId: a.session.id }))).toBe('ok');
    expect(await codeOf(d.call(a.actor, 'artifact.list', { rootSessionId: a.parent.id }))).toBe(
      'forbidden',
    );
  });
});
