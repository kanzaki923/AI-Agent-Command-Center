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
