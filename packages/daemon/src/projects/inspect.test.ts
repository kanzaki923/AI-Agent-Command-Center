import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { HUMAN, type TestDaemonNoServer, createTestDaemon } from '../testing';
import { type TempRepo, createTempRepo, isolateGitConfig } from '../workspace/git-fixture';
import { detectTestCommand } from './inspect';

vi.setConfig({ testTimeout: 60_000 });

let restoreGit: () => void;
beforeAll(() => {
  restoreGit = isolateGitConfig();
});
afterAll(() => restoreGit());

let d: TestDaemonNoServer | undefined;
let repo: TempRepo | undefined;
const dirs: string[] = [];
afterEach(async () => {
  await d?.cleanup();
  await repo?.cleanup();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  d = undefined;
  repo = undefined;
});

function tempDir(files: Record<string, string> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), 'acc-inspect-'));
  dirs.push(dir);
  for (const [f, c] of Object.entries(files)) {
    mkdirSync(join(dir, f, '..'), { recursive: true });
    writeFileSync(join(dir, f), c);
  }
  return dir;
}

describe('project.inspectFolder (any folder, git optional)', () => {
  it('accepts a plain folder and names the existing project', async () => {
    d = await createTestDaemon();
    const dir = tempDir({ 'notes.md': '# x' });
    const r = await d.call(HUMAN, 'project.inspectFolder', { path: dir });
    expect(r).toMatchObject({
      ok: true,
      reason: null,
      path: dir,
      isGitRepo: false,
      repoRoot: null,
      defaultBranch: null,
      suggestedName: basename(dir),
      suggestedTestCommand: null,
      existingProjectId: null,
    });
    const p = await d.call(HUMAN, 'project.create', { name: '資料', folderPath: dir });
    expect((await d.call(HUMAN, 'project.inspectFolder', { path: dir })).existingProjectId).toBe(
      p.id,
    );
  });

  it('names the repository of a folder inside one, with its default branch', async () => {
    repo = await createTempRepo({
      'docs/guide.md': '# guide',
      'package.json': JSON.stringify({ scripts: { test: 'vitest' } }),
      'pnpm-lock.yaml': '',
    });
    d = await createTestDaemon();
    const sub = join(repo.path, 'docs');
    const r = await d.call(HUMAN, 'project.inspectFolder', { path: sub });
    expect(r).toMatchObject({ ok: true, isGitRepo: true, defaultBranch: 'main' });
    expect(r.repoRoot && basename(r.repoRoot)).toBe(basename(repo.path));
    expect(r.suggestedTestCommand).toBe('pnpm test');
    const p = await d.call(HUMAN, 'project.create', { name: 'app', repoPath: repo.path });
    expect((await d.call(HUMAN, 'project.inspectFolder', { path: sub })).existingProjectId).toBe(
      p.id,
    );
  });

  it('explains what is wrong in Japanese', async () => {
    d = await createTestDaemon();
    const dir = tempDir({ 'a.txt': 'x' });
    const fail = async (path: string) => {
      const r = await d!.call(HUMAN, 'project.inspectFolder', { path });
      expect(r.ok).toBe(false);
      return r.reason;
    };
    expect(await fail('relative/dir')).toContain('絶対パス');
    expect(await fail(join(dir, 'missing'))).toContain('見つかりません');
    expect(await fail(join(dir, 'a.txt'))).toContain('フォルダを指定');
  });
});

describe('project.inspectRepo', () => {
  it('describes a repository root and suggests settings, without creating anything', async () => {
    repo = await createTempRepo({
      'package.json': JSON.stringify({ name: 'x', scripts: { test: 'vitest run' } }),
      'pnpm-lock.yaml': '',
    });
    d = await createTestDaemon();
    const before = readdirSync(repo.path).sort();
    const r = await d.call(HUMAN, 'project.inspectRepo', { path: repo.path });
    expect(r).toMatchObject({
      ok: true,
      reason: null,
      defaultBranch: 'main',
      currentBranch: 'main',
      isDirty: false,
      suggestedName: basename(repo.path),
      suggestedTestCommand: 'pnpm test',
      existingProjectId: null,
    });
    expect(readdirSync(repo.path).sort()).toEqual(before);
    expect((await d.call(HUMAN, 'project.list', {})).items).toEqual([]);

    // Dirty working tree and an already registered project.
    repo.write('new.txt', 'x\n');
    const project = await d.call(HUMAN, 'project.create', { name: 'x', repoPath: repo.path });
    expect(await d.call(HUMAN, 'project.inspectRepo', { path: repo.path })).toMatchObject({
      ok: true,
      isDirty: true,
      existingProjectId: project.id,
    });
  });

  it('explains why a path cannot be used', async () => {
    repo = await createTempRepo({ 'src/a.txt': 'a\n' });
    d = await createTestDaemon();
    const inspect = (path: string) => d!.call(HUMAN, 'project.inspectRepo', { path });

    expect(await inspect('relative/path')).toMatchObject({ ok: false });
    expect((await inspect(join(tempDir(), 'missing'))).reason).toContain('見つかりません');
    expect((await inspect(tempDir())).reason).toContain('git リポジトリではありません');
    const sub = await inspect(join(repo.path, 'src'));
    expect(sub.ok).toBe(false);
    expect(sub.reason).toContain('ルート');
    expect(sub.repoRoot).not.toBeNull();
  });
});

describe('detectTestCommand', () => {
  it('reads package.json scripts and lockfiles, then other ecosystems', () => {
    const pkg = (test: string) => JSON.stringify({ scripts: { test } });
    expect(detectTestCommand(tempDir({ 'package.json': pkg('jest') }))).toBe('npm test');
    expect(detectTestCommand(tempDir({ 'package.json': pkg('jest'), 'yarn.lock': '' }))).toBe(
      'yarn test',
    );
    // npm init's placeholder is not a test suite.
    expect(
      detectTestCommand(
        tempDir({ 'package.json': pkg('echo "Error: no test specified" && exit 1') }),
      ),
    ).toBeNull();
    expect(detectTestCommand(tempDir({ 'Cargo.toml': '[package]' }))).toBe('cargo test');
    expect(detectTestCommand(tempDir({ 'go.mod': 'module x' }))).toBe('go test ./...');
    expect(detectTestCommand(tempDir({ 'pyproject.toml': '[tool.pytest.ini_options]\n' }))).toBe(
      'pytest',
    );
    expect(detectTestCommand(tempDir({ 'README.md': '# x' }))).toBeNull();
  });
});
