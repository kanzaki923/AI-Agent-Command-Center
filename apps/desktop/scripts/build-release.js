// `pnpm build:desktop`: the distributable build (`tauri build`) that is safe to publish.
//
// rustc embeds absolute source paths (panic locations, file!()) of every crate, which puts the
// builder's home directory (and so their OS user name) into the exe through ~/.cargo/registry.
// This script remaps those prefixes to neutral ones, then scans what gets shipped and fails the
// build if the home directory or the checkout path is still in it.
//
//   node scripts/build-release.js [tauri build args...]   e.g. --debug, --no-bundle, --target <triple>
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const desktopDir = join(here, '..');
const tauriDir = join(desktopDir, 'src-tauri');
const repoRoot = join(desktopDir, '..', '..');

/**
 * `--remap-path-prefix` flags for the local paths that end up in a Rust binary. rustc uses the
 * last matching flag, so the catch-all home directory comes first and the specific ones after.
 */
export function remapFlags({ home, repo, cargoHome, rustupHome }) {
  const pairs = [
    [home, '/home'],
    [cargoHome ?? join(home, '.cargo'), '/cargo'],
    [rustupHome ?? join(home, '.rustup'), '/rustup'],
    [repo, '/acc'],
  ];
  return pairs.map(([from, to]) => `--remap-path-prefix=${from}=${to}`);
}

/**
 * The value for CARGO_ENCODED_RUSTFLAGS (0x1f-separated, so paths with spaces survive). Cargo
 * ignores RUSTFLAGS once the encoded form is set, so flags the caller already had are kept.
 */
export function encodedRustflags(env, flags) {
  const existing = env.CARGO_ENCODED_RUSTFLAGS
    ? env.CARGO_ENCODED_RUSTFLAGS.split('\x1f')
    : (env.RUSTFLAGS ?? '').split(/\s+/);
  return [...existing.filter(Boolean), ...flags].join('\x1f');
}

/** Every spelling of a path that can appear in a binary or a source map. */
export function pathNeedles(path) {
  const back = path.replaceAll('/', '\\');
  const fwd = path.replaceAll('\\', '/');
  return [...new Set([back, fwd, back.replaceAll('\\', '\\\\')])];
}

/** The needles found in `buf` (case-insensitive; UTF-8 and UTF-16LE). */
export function findLeaks(buf, needles) {
  const text = buf.toString('latin1').toLowerCase();
  return needles.filter((n) => {
    const lower = n.toLowerCase();
    if (text.includes(lower)) return true;
    return text.includes(Buffer.from(lower, 'utf16le').toString('latin1'));
  });
}

/** `tauri build` args -> the cargo output directory (target[/<triple>]/<release|debug>). */
export function profileDir(args, tauri = tauriDir) {
  const t = args.indexOf('--target');
  const triple = t >= 0 ? args[t + 1] : null;
  const profile = args.includes('--debug') ? 'debug' : 'release';
  return triple ? join(tauri, 'target', triple, profile) : join(tauri, 'target', profile);
}

function filesUnder(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => join(e.parentPath, e.name));
}

/** What the build ships, uncompressed where possible (the installer itself is LZMA-packed). */
export function shippedFiles(args, tauri = tauriDir) {
  const out = profileDir(args, tauri);
  const ext = process.platform === 'win32' ? '.exe' : '';
  return [
    join(out, `acc-desktop${ext}`),
    ...filesUnder(join(tauri, 'resources', 'daemon')),
    ...filesUnder(join(out, 'bundle')),
  ].filter((f) => existsSync(f) && statSync(f).isFile());
}

function main(args) {
  const home = homedir();
  const flags = remapFlags({
    home,
    repo: repoRoot,
    cargoHome: process.env.CARGO_HOME,
    rustupHome: process.env.RUSTUP_HOME,
  });
  const env = { ...process.env, CARGO_ENCODED_RUSTFLAGS: encodedRustflags(process.env, flags) };
  delete env.RUSTFLAGS;

  const r = spawnSync('pnpm', ['exec', 'tauri', 'build', ...args], {
    cwd: desktopDir,
    env,
    stdio: 'inherit',
    shell: process.platform === 'win32', // pnpm is pnpm.cmd on Windows
  });
  if (r.status !== 0) process.exit(r.status ?? 1);

  const needles = [...pathNeedles(home), ...pathNeedles(repoRoot)];
  const leaks = shippedFiles(args)
    .map((f) => ({ file: relative(repoRoot, f), found: findLeaks(readFileSync(f), needles) }))
    .filter((l) => l.found.length > 0);
  if (leaks.length > 0) {
    console.error('build-release: ローカルのパスが配布物に残っています。公開しないでください。');
    for (const l of leaks) console.error(`  ${l.file}: ${l.found.length} 種類のパス`);
    process.exit(1);
  }
  console.log('build-release: 配布物にローカルのパスは含まれていません。');
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const args = process.argv.slice(2);
  main(args[0] === '--' ? args.slice(1) : args); // `pnpm build:desktop -- --no-bundle`
}
