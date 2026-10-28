// Puts the Node runtime where tauri.conf.json `bundle.externalBin` expects it.
// tauri-build fails (even for `cargo check` / `tauri dev`) when the file is missing.
//   dev      : copy the Node that runs this script (fast, offline)
//   --release: TODO download a pinned official Node build + verify SHASUMS256 (CI)
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', 'src-tauri');
const triple = execFileSync('rustc', ['--print', 'host-tuple'], { encoding: 'utf8' }).trim();
const ext = process.platform === 'win32' ? '.exe' : '';
const dest = join(root, 'binaries', `acc-node-${triple}${ext}`);
mkdirSync(dirname(dest), { recursive: true });
if (process.argv.includes('--release')) {
  throw new Error('release: download pinned Node and verify checksum (not implemented yet)');
}
if (!existsSync(dest) || statSync(dest).size !== statSync(process.execPath).size) {
  copyFileSync(process.execPath, dest);
  console.log(`sidecar: ${process.execPath} -> ${dest}`);
}
// resources/daemon must also exist for tauri-build; the real bundle comes from the daemon package
mkdirSync(join(root, 'resources', 'daemon'), { recursive: true });
