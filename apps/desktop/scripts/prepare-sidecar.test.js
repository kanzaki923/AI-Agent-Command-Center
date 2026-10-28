// @vitest-environment node
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  NODE_RUNTIME,
  fetchPinned,
  nodeDistFor,
  preparePinnedNode,
  sha256,
} from './prepare-sidecar.js';

const dirs = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function tmp() {
  const d = mkdtempSync(join(tmpdir(), 'acc-sidecar-'));
  dirs.push(d);
  return d;
}

const body = Buffer.from('pretend this is node.exe');
const runtime = { version: '0.0.1', sha256: { 'win-x64/node.exe': sha256(body) } };
const ok = (buf) => async () => ({ ok: true, status: 200, arrayBuffer: async () => buf });
const offline = async () => {
  throw new Error('network is off');
};

describe('nodeDistFor', () => {
  it('maps Rust target triples to official Node downloads', () => {
    expect(nodeDistFor('x86_64-pc-windows-msvc', '22.0.0')).toEqual({
      file: 'win-x64/node.exe',
      archive: false,
    });
    expect(nodeDistFor('aarch64-apple-darwin', '22.0.0')).toEqual({
      file: 'node-v22.0.0-darwin-arm64.tar.gz',
      archive: true,
      member: 'node-v22.0.0-darwin-arm64/bin/node',
    });
    expect(nodeDistFor('x86_64-unknown-linux-gnu', '22.0.0').file).toBe(
      'node-v22.0.0-linux-x64.tar.gz',
    );
    expect(() => nodeDistFor('riscv64gc-unknown-linux-gnu')).toThrow('unsupported');
  });

  it('has a pinned checksum for every supported desktop target', () => {
    for (const triple of [
      'x86_64-pc-windows-msvc',
      'aarch64-pc-windows-msvc',
      'x86_64-apple-darwin',
      'aarch64-apple-darwin',
      'x86_64-unknown-linux-gnu',
      'aarch64-unknown-linux-gnu',
    ]) {
      expect(NODE_RUNTIME.sha256[nodeDistFor(triple).file]).toMatch(/^[0-9a-f]{64}$/);
    }
  });
});

describe('fetchPinned', () => {
  it('downloads once, then works offline from the verified cache', async () => {
    const cacheDir = tmp();
    const dist = nodeDistFor('x86_64-pc-windows-msvc', runtime.version);
    const fetch = vi.fn(ok(body));
    const first = await fetchPinned(dist, { runtime, cacheDir, fetch });
    expect(first.downloaded).toBe(true);
    expect(fetch).toHaveBeenCalledWith('https://nodejs.org/dist/v0.0.1/win-x64/node.exe');

    const second = await fetchPinned(dist, { runtime, cacheDir, fetch: offline });
    expect(second.downloaded).toBe(false);
    expect(second.buf.equals(body)).toBe(true);
  });

  it('never accepts bytes that differ from the pinned hash', async () => {
    const cacheDir = tmp();
    const dist = nodeDistFor('x86_64-pc-windows-msvc', runtime.version);
    await expect(
      fetchPinned(dist, { runtime, cacheDir, fetch: ok(Buffer.from('evil')) }),
    ).rejects.toThrow('checksum mismatch');
    await expect(fetchPinned(dist, { runtime, cacheDir, fetch: offline })).rejects.toThrow(
      'offline and not cached',
    );

    // A tampered cache entry is discarded and fetched again.
    const { path } = await fetchPinned(dist, { runtime, cacheDir, fetch: ok(body) });
    writeFileSync(path, 'tampered');
    const fetch = vi.fn(ok(body));
    expect((await fetchPinned(dist, { runtime, cacheDir, fetch })).downloaded).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

describe('preparePinnedNode', () => {
  it('writes the sidecar with a marker and skips the work when it is up to date', async () => {
    const dir = tmp();
    const dest = join(dir, 'binaries', 'acc-node-x86_64-pc-windows-msvc.exe');
    const opts = { runtime, cacheDir: join(dir, 'cache'), dest };
    expect(
      await preparePinnedNode('x86_64-pc-windows-msvc', { ...opts, fetch: ok(body) }),
    ).toMatchObject({
      changed: true,
    });
    expect(readFileSync(dest).equals(body)).toBe(true);
    expect(JSON.parse(readFileSync(`${dest}.json`, 'utf8'))).toMatchObject({
      version: '0.0.1',
      source: 'win-x64/node.exe',
    });
    expect(
      await preparePinnedNode('x86_64-pc-windows-msvc', { ...opts, fetch: offline }),
    ).toMatchObject({
      changed: false,
    });

    // A dev copy of some other node at the same path gets replaced by the pinned one.
    writeFileSync(dest, 'local dev node');
    expect(
      await preparePinnedNode('x86_64-pc-windows-msvc', { ...opts, fetch: offline }),
    ).toMatchObject({
      changed: true,
    });
    expect(readFileSync(dest).equals(body)).toBe(true);
  });
});
