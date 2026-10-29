// UI audit (ui-redesign spec §10): builds the scene of scripts/audit-scene.ts (real daemon,
// mock models and mock runtime only: three delegated trees, a schedule, plain chats; more
// than ten agents at once) in a fresh ACC_HOME on free ports, serves the UI with Vite, and
// screenshots every screen (e2e/audit-shots.js lists them) — first the empty app, then the
// scene.
//
//   node e2e/audit.js [--out <dir>] [--theme dark|light] [--serve] [--keep]
//
// --serve  build the scene and keep the stack running (no screenshots) for manual review
// --keep   keep ACC_HOME after the run
// Screenshots go to the OS temp dir by default (never into the repo).
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { flag, log, opt, startScene } from './harness.js';

const out = opt('out', join(tmpdir(), 'acc-audit-shots'));
const theme = opt('theme', 'dark');

const scene = await startScene();
const stop = () => scene.stop({ keep: flag('keep') });
process.on('SIGINT', () => void stop().finally(() => process.exit(130)));

try {
  if (flag('serve')) {
    await scene.build();
    log(`serving ${scene.url} (Ctrl+C to stop)`);
    await new Promise(() => {});
  }
  mkdirSync(out, { recursive: true });
  const { shoot } = await import('./audit-shots.js');
  const result = await shoot({ url: scene.url, out, theme, build: () => scene.build() });
  if (result.errors.length) process.exitCode = 1;
} finally {
  await stop();
}
