// Bundle the Core Daemon into one ESM file for the packaged desktop app.
//
//   node packages/daemon/scripts/bundle.js [--out <file>]   (default: packages/daemon/dist/main.mjs)
//
// Everything is inlined, including the Claude Agent SDK's JavaScript (it imports only Node
// built-ins). The SDK's ~300MB native CLI is NOT shipped: inside a bundle the SDK cannot
// `require.resolve` its platform package, so the daemon locates an installed Claude Code
// itself (src/runtime/claude/locate.ts) and the runtime reports a Japanese reason when there
// is none. See docs/snapshot/20261029_desktop-packaging.md.
//
// Run the result with: node --disable-warning=ExperimentalWarning --enable-source-maps main.mjs
import { mkdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const pkgDir = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * @param {{ outfile?: string, quiet?: boolean }} [opts]
 * @returns {Promise<{ outfile: string, bytes: number, packages: string[] }>}
 */
export async function bundleDaemon(opts = {}) {
  const outfile = resolve(opts.outfile ?? join(pkgDir, 'dist', 'main.mjs'));
  mkdirSync(dirname(outfile), { recursive: true });
  const result = await build({
    entryPoints: [join(pkgDir, 'src', 'main.ts')],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    sourcemap: 'linked',
    legalComments: 'eof',
    metafile: true,
    logLevel: opts.quiet ? 'error' : 'warning',
    // CommonJS dependencies (ws, ...) call require() for Node built-ins; ESM has no require.
    banner: {
      js: "import { createRequire as __accCreateRequire } from 'node:module';\nconst require = __accCreateRequire(import.meta.url);",
    },
    // Optional native speed-ups of `ws`, loaded in try/catch when present.
    external: ['bufferutil', 'utf-8-validate'],
  });
  const packages = new Set();
  for (const input of Object.keys(result.metafile.inputs)) {
    const m =
      /node_modules[\\/](?:\.pnpm[\\/][^\\/]+[\\/]node_modules[\\/])?((?:@[^\\/]+[\\/])?[^\\/]+)/.exec(
        input,
      );
    if (m) packages.add(m[1].replace(/\\/g, '/'));
  }
  return { outfile, bytes: statSync(outfile).size, packages: [...packages].sort() };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const i = process.argv.indexOf('--out');
  const outfile = i > 0 ? process.argv[i + 1] : undefined;
  const r = await bundleDaemon(outfile ? { outfile } : {});
  console.log(
    `daemon bundle: ${relative(process.cwd(), r.outfile)} (${(r.bytes / 1024 / 1024).toFixed(1)} MB; ${r.packages.join(', ')})`,
  );
}
