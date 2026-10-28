import { existsSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Where the Claude Code CLI executable comes from. The Agent SDK spawns it for every run;
 * by default the SDK `require.resolve`s it from its per-platform optional dependency
 * (`@anthropic-ai/claude-agent-sdk-<platform>-<arch>/claude[.exe]`, ~300MB). That works in the
 * repo, but not from the packaged app's single-file daemon bundle (no node_modules), so the
 * daemon always resolves the path itself and passes `pathToClaudeCodeExecutable`.
 *
 * Order:
 * 1. `ACC_CLAUDE_CODE_PATH`: explicit override.
 * 2. `<bundle dir>/claude/claude[.exe]`: shipped next to the daemon bundle (opt-in packaging).
 * 3. The SDK's own platform package (development / unbundled installs; version-matched).
 * 4. An installed Claude Code: `claude[.exe]` on PATH, then `~/.local/bin` (native installer).
 */
export type ClaudeCodeSource = 'env' | 'bundled' | 'sdk' | 'path' | 'home';

export type ClaudeCodeLocation =
  { ok: true; path: string; source: ClaudeCodeSource } | { ok: false; reason: string };

export interface LocateClaudeCodeOptions {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  arch?: string;
  home?: string;
  /** Directory holding the running daemon code (the bundle's dir in the packaged app). */
  bundleDir?: string | null;
  isFile?: (path: string) => boolean;
  /** Path of the SDK's platform binary, or null when the SDK package cannot resolve it. */
  resolveSdkBinary?: () => string | null;
}

export const CLAUDE_CODE_PATH_ENV = 'ACC_CLAUDE_CODE_PATH';

export function locateClaudeCode(opts: LocateClaudeCodeOptions = {}): ClaudeCodeLocation {
  const env = opts.env ?? process.env;
  const platform = opts.platform ?? process.platform;
  const isFile = opts.isFile ?? defaultIsFile;
  const exe = platform === 'win32' ? 'claude.exe' : 'claude';

  const explicit = env[CLAUDE_CODE_PATH_ENV];
  if (explicit) {
    if (isFile(explicit)) return { ok: true, path: explicit, source: 'env' };
    return {
      ok: false,
      reason: `${CLAUDE_CODE_PATH_ENV} に指定された Claude Code の実行ファイルが見つかりません: ${explicit}`,
    };
  }

  const bundleDir = opts.bundleDir === undefined ? defaultBundleDir() : opts.bundleDir;
  if (bundleDir) {
    const bundled = join(bundleDir, 'claude', exe);
    if (isFile(bundled)) return { ok: true, path: bundled, source: 'bundled' };
  }

  const sdk = (opts.resolveSdkBinary ?? (() => resolveSdkBinary(platform, opts.arch)))();
  if (sdk && isFile(sdk)) return { ok: true, path: sdk, source: 'sdk' };

  const pathVar = env.PATH ?? env.Path ?? '';
  for (const dir of pathVar.split(platform === 'win32' ? ';' : delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, exe);
    if (isFile(candidate)) return { ok: true, path: candidate, source: 'path' };
  }

  const home = opts.home ?? homedir();
  const local = join(home, '.local', 'bin', exe);
  if (isFile(local)) return { ok: true, path: local, source: 'home' };

  return {
    ok: false,
    reason:
      'Claude Code の実行ファイルが見つかりません。Claude Code をインストールする（https://claude.com/claude-code）か、' +
      `環境変数 ${CLAUDE_CODE_PATH_ENV} に claude${platform === 'win32' ? '.exe' : ''} のパスを設定してください（環境変数を変えたら Core Daemon の再起動が必要です）`,
  };
}

function defaultIsFile(path: string): boolean {
  try {
    return existsSync(path) && statSync(path).isFile();
  } catch {
    return false;
  }
}

function defaultBundleDir(): string | null {
  try {
    return dirname(fileURLToPath(import.meta.url));
  } catch {
    return null;
  }
}

/** Same candidates as the SDK's own lookup (musl variants on Linux). */
function resolveSdkBinary(platform: NodeJS.Platform, arch: string = process.arch): string | null {
  const ext = platform === 'win32' ? '.exe' : '';
  const names =
    platform === 'linux' ? [`linux-${arch}`, `linux-${arch}-musl`] : [`${platform}-${arch}`];
  try {
    // Resolve from the SDK's location: with pnpm the platform package is only visible there.
    const sdkEntry = createRequire(import.meta.url).resolve('@anthropic-ai/claude-agent-sdk');
    const fromSdk = createRequire(sdkEntry);
    for (const name of names) {
      try {
        return fromSdk.resolve(`@anthropic-ai/claude-agent-sdk-${name}/claude${ext}`);
      } catch {
        // try the next candidate
      }
    }
  } catch {
    // SDK not installed next to this code (e.g. the packaged single-file bundle)
  }
  return null;
}
