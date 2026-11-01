import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { locateClaudeCode } from './locate';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'acc-locate-'));
  dirs.push(d);
  return d;
}

function touch(path: string): string {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, '');
  return path;
}

const none = () => null;

describe('locateClaudeCode', () => {
  it('prefers ACC_CLAUDE_CODE_PATH and explains when it points nowhere', () => {
    const root = tmp();
    const exe = touch(join(root, 'custom', 'claude.exe'));
    touch(join(root, 'bundle', 'claude', 'claude.exe')); // lower priority than the env var
    expect(
      locateClaudeCode({
        env: { ACC_CLAUDE_CODE_PATH: exe },
        platform: 'win32',
        bundleDir: join(root, 'bundle'),
        resolveSdkBinary: none,
      }),
    ).toEqual({ ok: true, path: exe, source: 'env' });

    const missing = locateClaudeCode({
      env: { ACC_CLAUDE_CODE_PATH: join(root, 'nope.exe') },
      platform: 'win32',
      bundleDir: join(root, 'bundle'),
      resolveSdkBinary: none,
    });
    expect(missing).toMatchObject({ ok: false, reason: expect.stringContaining('nope.exe') });

    // Relative: it would be found from the cwd of the run (the workspace), never used.
    const relative = locateClaudeCode({
      env: { ACC_CLAUDE_CODE_PATH: 'claude.exe' },
      platform: 'win32',
      bundleDir: join(root, 'bundle'),
      resolveSdkBinary: none,
      isFile: () => true,
    });
    expect(relative).toMatchObject({ ok: false, reason: expect.stringContaining('絶対パス') });
  });

  it('skips relative PATH entries (`.` is the workspace the CLI runs in)', () => {
    const r = locateClaudeCode({
      env: { PATH: '.;bin' },
      platform: 'win32',
      bundleDir: null,
      home: tmp(),
      resolveSdkBinary: none,
      isFile: (p) => !p.includes(':') && p.endsWith('claude.exe'),
    });
    expect(r).toMatchObject({ ok: false });
  });

  it('then a binary shipped next to the bundle, then the SDK package, then PATH, then ~/.local/bin', () => {
    const root = tmp();
    const bundleDir = join(root, 'resources', 'daemon');
    const pathDir = join(root, 'bin');
    const home = join(root, 'home');
    // The real platform: PATH entries are this machine's paths.
    const exe = process.platform === 'win32' ? 'claude.exe' : 'claude';
    const sdkBin = join(root, 'sdk', exe);
    const base = {
      env: { PATH: [join(root, 'empty'), pathDir].join(delimiter) },
      platform: process.platform,
      bundleDir,
      home,
      resolveSdkBinary: () => sdkBin,
    };
    expect(locateClaudeCode(base)).toMatchObject({ ok: false });

    touch(join(home, '.local', 'bin', exe));
    expect(locateClaudeCode(base)).toMatchObject({ ok: true, source: 'home' });
    touch(join(pathDir, exe));
    expect(locateClaudeCode(base)).toEqual({
      ok: true,
      path: join(pathDir, exe),
      source: 'path',
    });
    touch(sdkBin);
    expect(locateClaudeCode(base)).toEqual({ ok: true, path: sdkBin, source: 'sdk' });
    touch(join(bundleDir, 'claude', exe));
    expect(locateClaudeCode(base)).toMatchObject({ ok: true, source: 'bundled' });
  });

  it('uses claude.exe on Windows and gives a Japanese reason when nothing is found', () => {
    const root = tmp();
    touch(join(root, 'bin', 'claude')); // not an .exe: ignored on Windows
    const r = locateClaudeCode({
      env: { PATH: join(root, 'bin') },
      platform: 'win32',
      bundleDir: null,
      home: root,
      resolveSdkBinary: none,
    });
    expect(r).toMatchObject({ ok: false, reason: expect.stringContaining('claude.exe') });
    if (!r.ok) expect(r.reason).toContain('Claude Code の実行ファイルが見つかりません');
  });

  it('finds the SDK platform binary installed in this repo', () => {
    // Development installs ship it as an optional dependency (pnpm keeps it next to the SDK).
    const r = locateClaudeCode({ env: {}, bundleDir: null, home: tmp() });
    if (r.ok) expect(r.source).toBe('sdk');
    else expect(r.reason).toBeTruthy(); // optional deps skipped on this machine
  });
});
