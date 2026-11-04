// @vitest-environment node
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  encodedRustflags,
  findLeaks,
  pathNeedles,
  profileDir,
  remapFlags,
  shippedFiles,
} from './build-release.js';

const dirs = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('remapFlags', () => {
  it('maps the home directory, cargo, rustup and the checkout, most specific last', () => {
    expect(remapFlags({ home: 'C:\\Users\\me', repo: 'D:\\src\\acc' })).toEqual([
      '--remap-path-prefix=C:\\Users\\me=/home',
      `--remap-path-prefix=${join('C:\\Users\\me', '.cargo')}=/cargo`,
      `--remap-path-prefix=${join('C:\\Users\\me', '.rustup')}=/rustup`,
      '--remap-path-prefix=D:\\src\\acc=/acc',
    ]);
  });

  it('uses CARGO_HOME and RUSTUP_HOME when they are set', () => {
    const flags = remapFlags({
      home: '/home/me',
      repo: '/home/me/acc',
      cargoHome: '/opt/cargo',
      rustupHome: '/opt/rustup',
    });
    expect(flags).toContain('--remap-path-prefix=/opt/cargo=/cargo');
    expect(flags).toContain('--remap-path-prefix=/opt/rustup=/rustup');
  });
});

describe('encodedRustflags', () => {
  it('keeps paths with spaces as single flags', () => {
    const flags = ['--remap-path-prefix=C:\\Users\\John Doe=/home'];
    expect(encodedRustflags({}, flags).split('\x1f')).toEqual(flags);
  });

  it('keeps flags the caller already had in RUSTFLAGS', () => {
    expect(
      encodedRustflags({ RUSTFLAGS: ' -C target-cpu=native ' }, ['--x']).split('\x1f'),
    ).toEqual(['-C', 'target-cpu=native', '--x']);
  });

  it('prefers an existing CARGO_ENCODED_RUSTFLAGS over RUSTFLAGS, as cargo does', () => {
    const env = { CARGO_ENCODED_RUSTFLAGS: '-C\x1fopt-level=3', RUSTFLAGS: '-C debuginfo=2' };
    expect(encodedRustflags(env, ['--x']).split('\x1f')).toEqual(['-C', 'opt-level=3', '--x']);
  });
});

describe('pathNeedles and findLeaks', () => {
  const needles = pathNeedles('C:\\Users\\me');

  it('covers backslash, forward-slash and JSON-escaped spellings', () => {
    expect(needles).toEqual(['C:\\Users\\me', 'C:/Users/me', 'C:\\\\Users\\\\me']);
  });

  it('finds a path embedded in a binary, ignoring case', () => {
    const buf = Buffer.concat([
      Buffer.from([0, 1, 2]),
      Buffer.from('c:\\users\\me\\.cargo\\registry\\src\\x.rs'),
      Buffer.from([0]),
    ]);
    expect(findLeaks(buf, needles)).toEqual(['C:\\Users\\me']);
  });

  it('finds UTF-16LE strings and escaped paths in source maps', () => {
    expect(findLeaks(Buffer.from('C:\\Users\\me\\a.rs', 'utf16le'), needles)).toEqual([
      'C:\\Users\\me',
    ]);
    expect(findLeaks(Buffer.from('{"sources":["C:\\\\Users\\\\me\\\\a.ts"]}'), needles)).toEqual(
      expect.arrayContaining(['C:\\\\Users\\\\me']),
    );
  });

  it('reports nothing for remapped paths', () => {
    expect(findLeaks(Buffer.from('/cargo/registry/src/x.rs /acc/src/main.rs'), needles)).toEqual(
      [],
    );
  });
});

describe('profileDir and shippedFiles', () => {
  it('follows --debug and --target like cargo does', () => {
    expect(profileDir([], 't')).toBe(join('t', 'target', 'release'));
    expect(profileDir(['--debug'], 't')).toBe(join('t', 'target', 'debug'));
    expect(profileDir(['--target', 'aarch64-pc-windows-msvc'], 't')).toBe(
      join('t', 'target', 'aarch64-pc-windows-msvc', 'release'),
    );
  });

  it('lists the app binary, the daemon bundle and every bundle output', () => {
    const tauri = mkdtempSync(join(tmpdir(), 'acc-release-'));
    dirs.push(tauri);
    const out = join(tauri, 'target', 'release');
    const exe = join(out, process.platform === 'win32' ? 'acc-desktop.exe' : 'acc-desktop');
    const daemon = join(tauri, 'resources', 'daemon');
    const nsis = join(out, 'bundle', 'nsis');
    for (const d of [daemon, nsis]) mkdirSync(d, { recursive: true });
    for (const f of [exe, join(daemon, 'main.mjs'), join(nsis, 'setup.exe')]) writeFileSync(f, 'x');
    writeFileSync(join(out, 'unrelated.pdb'), 'x');

    expect(shippedFiles([], tauri).sort()).toEqual(
      [exe, join(daemon, 'main.mjs'), join(nsis, 'setup.exe')].sort(),
    );
  });
});
