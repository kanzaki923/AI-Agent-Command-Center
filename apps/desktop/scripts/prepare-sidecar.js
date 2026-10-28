// Prepares what tauri.conf.json bundles next to the app:
//   bundle.externalBin  binaries/acc-node-<target-triple>[.exe]  the Node runtime for the daemon
//   bundle.resources    resources/daemon/main.mjs (+ .map)        the daemon bundle (esbuild)
// tauri-build checks both paths exist even for `cargo check` / `tauri dev`.
//
//   node scripts/prepare-sidecar.js            dev: any Node (copies this one if missing) and an
//                                              empty resources/daemon/ (tauri dev runs the daemon
//                                              from source)
//   node scripts/prepare-sidecar.js --release  the pinned official Node (downloaded once into the
//                                              build cache, SHA-256 checked against the value
//                                              pinned below, then reused offline) + the bundle
//     --target <triple>     cross-build for another Rust target triple
//     --with-claude-code    also ship the Agent SDK's native Claude Code CLI (~300MB) as
//                           resources/daemon/claude/ (otherwise an installed one is used)
//
// Binaries and the cache are never committed (.gitignore: binaries/, resources/daemon/).
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const tauriDir = join(here, '..', 'src-tauri');
const repoRoot = join(here, '..', '..', '..');

/**
 * The Node runtime shipped with the app. To bump: pick a Node 22 LTS release, copy the lines
 * from https://nodejs.org/dist/v<version>/SHASUMS256.txt, run `--release` once.
 */
export const NODE_RUNTIME = {
  version: '22.23.3',
  sha256: {
    'win-x64/node.exe': '9c9245166b4a8e182e0b797da9c20136117ff24368eaff1fec8343a123c8db0e',
    'win-arm64/node.exe': 'b5a3165ec6f24c0b1fe2a10fed58e03f6c1d7d141beb3b225ff030ceac6c5eb5',
    'node-v22.23.3-darwin-arm64.tar.gz':
      '23b25245dcfb9af7262f8ff142e9e2e0af025368117329e7a7458a51e5922f53',
    'node-v22.23.3-darwin-x64.tar.gz':
      '8a677b0219178efd6eb0e475457c4afb452b521a92f6e67845a73bd85727f2a8',
    'node-v22.23.3-linux-arm64.tar.gz':
      '5ced2d48d1d7198739b7f86804de0171aefb6823b684b12341d3321afc3cb0b2',
    'node-v22.23.3-linux-x64.tar.gz':
      '1084aa36196bba4c3a5e69a1ee388a6e4ff729dad09445fbcd434b28fe3c24af',
  },
};

/** Rust target triple -> the file to fetch from nodejs.org/dist/v<version>/. */
export function nodeDistFor(triple, version = NODE_RUNTIME.version) {
  const arch = triple.startsWith('x86_64-')
    ? 'x64'
    : triple.startsWith('aarch64-')
      ? 'arm64'
      : null;
  if (!arch) throw new Error(`unsupported target for the Node sidecar: ${triple}`);
  if (triple.includes('-windows-')) return { file: `win-${arch}/node.exe`, archive: false };
  const os = triple.includes('-apple-darwin')
    ? 'darwin'
    : triple.includes('-linux-')
      ? 'linux'
      : null;
  if (!os) throw new Error(`unsupported target for the Node sidecar: ${triple}`);
  return {
    file: `node-v${version}-${os}-${arch}.tar.gz`,
    archive: true,
    member: `node-v${version}-${os}-${arch}/bin/node`,
  };
}

export function sha256(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

export function defaultCacheDir(env = process.env, platform = process.platform) {
  if (env.ACC_BUILD_CACHE) return env.ACC_BUILD_CACHE;
  if (platform === 'win32' && env.LOCALAPPDATA) return join(env.LOCALAPPDATA, 'acc-build-cache');
  if (platform === 'darwin') return join(homedir(), 'Library', 'Caches', 'acc-build-cache');
  return join(env.XDG_CACHE_HOME || join(homedir(), '.cache'), 'acc-build-cache');
}

/**
 * Return the pinned Node download from the cache, fetching it only when missing or corrupt.
 * Never trusts a file whose hash differs from the pinned one (cached or downloaded).
 */
export async function fetchPinned(dist, opts = {}) {
  const runtime = opts.runtime ?? NODE_RUNTIME;
  const expected = runtime.sha256[dist.file];
  if (!expected) throw new Error(`no pinned SHA-256 for ${dist.file} (Node ${runtime.version})`);
  const cacheDir = join(opts.cacheDir ?? defaultCacheDir(), `node-v${runtime.version}`);
  const cached = join(cacheDir, dist.file.replaceAll('/', '-'));
  if (existsSync(cached)) {
    const buf = readFileSync(cached);
    if (sha256(buf) === expected) return { path: cached, buf, downloaded: false };
    rmSync(cached, { force: true }); // corrupt or tampered: fetch again
  }
  const url = `${opts.baseUrl ?? 'https://nodejs.org/dist'}/v${runtime.version}/${dist.file}`;
  const fetchFn = opts.fetch ?? fetch;
  let res;
  try {
    res = await fetchFn(url);
  } catch (err) {
    throw new Error(`cannot download ${url} (offline and not cached in ${cacheDir}?): ${err}`, {
      cause: err,
    });
  }
  if (!res.ok) throw new Error(`cannot download ${url}: HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const actual = sha256(buf);
  if (actual !== expected) {
    throw new Error(`checksum mismatch for ${url}: expected ${expected}, got ${actual}`);
  }
  mkdirSync(cacheDir, { recursive: true });
  const tmp = `${cached}.${process.pid}.tmp`;
  writeFileSync(tmp, buf);
  renameSync(tmp, cached);
  return { path: cached, buf, downloaded: true };
}

function hostTriple() {
  return execFileSync('rustc', ['--print', 'host-tuple'], { encoding: 'utf8' }).trim();
}

function sidecarPath(triple) {
  const ext = triple.includes('-windows-') ? '.exe' : '';
  return join(tauriDir, 'binaries', `acc-node-${triple}${ext}`);
}

/** Put the pinned Node at the externalBin path (no-op when it is already there). */
export async function preparePinnedNode(triple, opts = {}) {
  const dest = opts.dest ?? sidecarPath(triple);
  const marker = `${dest}.json`;
  const dist = nodeDistFor(triple, (opts.runtime ?? NODE_RUNTIME).version);
  try {
    const m = JSON.parse(readFileSync(marker, 'utf8'));
    if (m.source === dist.file && existsSync(dest) && sha256(readFileSync(dest)) === m.sha256) {
      return { dest, changed: false };
    }
  } catch {
    // no or unreadable marker: (re)create below
  }
  const got = await fetchPinned(dist, opts);
  mkdirSync(dirname(dest), { recursive: true });
  if (!dist.archive) {
    writeFileSync(dest, got.buf);
  } else {
    const out = mkdtempSync(join(tmpdir(), 'acc-node-'));
    try {
      execFileSync('tar', ['-xzf', got.path, '-C', out, dist.member]);
      copyFileSync(join(out, dist.member), dest);
      chmodSync(dest, 0o755);
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  }
  const runtime = opts.runtime ?? NODE_RUNTIME;
  writeFileSync(
    marker,
    JSON.stringify({
      version: runtime.version,
      source: dist.file,
      sha256: sha256(readFileSync(dest)),
    }),
  );
  return { dest, changed: true, downloaded: got.downloaded };
}

/** Dev: tauri-build only needs *a* file there; keep a pinned one if present. */
function prepareDevNode(triple) {
  const dest = sidecarPath(triple);
  if (existsSync(dest)) return { dest, changed: false };
  mkdirSync(dirname(dest), { recursive: true });
  copyFileSync(process.execPath, dest);
  return { dest, changed: true };
}

function claudeCodeBinary() {
  const fromDaemon = createRequire(join(repoRoot, 'packages', 'daemon', 'package.json'));
  const sdk = createRequire(fromDaemon.resolve('@anthropic-ai/claude-agent-sdk'));
  const exe = process.platform === 'win32' ? '.exe' : '';
  return sdk.resolve(
    `@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}/claude${exe}`,
  );
}

async function main(argv) {
  const release = argv.includes('--release');
  const t = argv.indexOf('--target');
  const triple = t >= 0 ? argv[t + 1] : hostTriple();
  const resources = join(tauriDir, 'resources', 'daemon');

  if (!release) {
    const r = prepareDevNode(triple);
    mkdirSync(resources, { recursive: true });
    if (r.changed) console.log(`sidecar (dev): ${process.execPath} -> ${r.dest}`);
    return;
  }

  const node = await preparePinnedNode(triple);
  console.log(
    `sidecar: Node ${NODE_RUNTIME.version} for ${triple} ${node.changed ? (node.downloaded ? '(downloaded, verified)' : '(from cache, verified)') : '(up to date)'}`,
  );

  rmSync(resources, { recursive: true, force: true });
  const { bundleDaemon } = await import(
    pathToFileURL(join(repoRoot, 'packages', 'daemon', 'scripts', 'bundle.js')).href
  );
  const b = await bundleDaemon({ outfile: join(resources, 'main.mjs') });
  console.log(`daemon bundle: ${(b.bytes / 1024 / 1024).toFixed(1)} MB (${b.packages.join(', ')})`);

  if (argv.includes('--with-claude-code')) {
    const src = claudeCodeBinary();
    const dest = join(resources, 'claude', process.platform === 'win32' ? 'claude.exe' : 'claude');
    mkdirSync(dirname(dest), { recursive: true });
    copyFileSync(src, dest);
    console.log(`claude code: ${src} -> ${dest}`);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main(process.argv.slice(2)).catch((err) => {
    console.error(`prepare-sidecar: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
