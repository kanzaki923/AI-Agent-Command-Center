import { statSync } from 'node:fs';
import path from 'node:path';
import type { Settings } from '@acc/protocol';

/**
 * Environment for agent child processes, built from an explicit allowlist.
 *
 * The Claude Agent SDK's `env` option REPLACES the child's whole environment, and we do not
 * want a developer's unrelated secrets (cloud tokens, ACC_* settings, ...) to leak into an
 * agent that can run commands. So only what a CLI needs to start and find the user's home,
 * temp dirs, shell and proxy is copied. Values are never logged — use `envKeys()`.
 */
export const BASE_ENV_ALLOWLIST: readonly string[] = [
  // Process basics
  'PATH',
  'PATHEXT',
  'SYSTEMROOT',
  'SYSTEMDRIVE',
  'WINDIR',
  'COMSPEC',
  'OS',
  'NUMBER_OF_PROCESSORS',
  'PROCESSOR_ARCHITECTURE',
  'PROGRAMDATA',
  'PROGRAMFILES',
  'PROGRAMFILES(X86)',
  'PROGRAMW6432',
  'COMMONPROGRAMFILES',
  'COMMONPROGRAMFILES(X86)',
  // User & home
  'HOME',
  'USERPROFILE',
  'HOMEDRIVE',
  'HOMEPATH',
  'APPDATA',
  'LOCALAPPDATA',
  'USER',
  'USERNAME',
  'LOGNAME',
  'SHELL',
  'XDG_CONFIG_HOME',
  'XDG_DATA_HOME',
  'XDG_CACHE_HOME',
  'XDG_STATE_HOME',
  'XDG_RUNTIME_DIR',
  // Temp
  'TEMP',
  'TMP',
  'TMPDIR',
  // Locale & terminal
  'LANG',
  'LANGUAGE',
  'LC_ALL',
  'LC_CTYPE',
  'TERM',
  'TZ',
  // Network (corporate proxies / CAs)
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'NODE_EXTRA_CA_CERTS',
  'SSL_CERT_FILE',
  // Claude Code installation (not credentials)
  'CLAUDE_CONFIG_DIR',
  'CLAUDE_CODE_GIT_BASH_PATH',
];

/** LiteLLM's per-request opt-in for the cost on a stream's usage (litellm core_helpers.py). */
export const LITELLM_STREAM_COST_HEADER = 'x-litellm-include-cost-in-streaming-usage';

/**
 * The user's own Claude Code login, inherited only when LiteLLM is NOT configured (so the
 * agent behaves like `claude` in their terminal). With LiteLLM these are replaced.
 */
export const CLAUDE_LOGIN_ENV: readonly string[] = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  'CLAUDE_CODE_OAUTH_TOKEN',
];

export type ModelRouting =
  | {
      kind: 'litellm';
      baseUrl: string;
      apiKey: string | null;
      /** LiteLLM model_name; null = let the CLI choose (it then calls its own default names). */
      model: string | null;
    }
  | { kind: 'claude-login'; model: string | null }
  /** An Anthropic API key of the user (settings.providers.anthropic), no proxy. */
  | { kind: 'anthropic-key'; apiKey: string; model: string | null };

/**
 * LiteLLM when a base URL is configured; otherwise the user's normal Claude Code login.
 * In login mode a model is passed only if it looks like a Claude model: the session's model
 * usually comes from `settings.defaultModel`, which names a LiteLLM alias.
 */
export function resolveModelRouting(
  settings: Settings,
  model: string | null | undefined,
): ModelRouting {
  const baseUrl = settings.litellm.baseUrl?.trim();
  if (baseUrl) {
    return {
      kind: 'litellm',
      baseUrl: normalizeAnthropicBaseUrl(baseUrl),
      apiKey: settings.litellm.apiKey ?? null,
      model: model ?? settings.defaultModel ?? null,
    };
  }
  const m = model ?? null;
  const claude = m && looksLikeClaudeModel(m) ? m.replace(/^anthropic\//, '') : null;
  const apiKey = settings.providers.anthropic.apiKey;
  if (apiKey) return { kind: 'anthropic-key', apiKey, model: claude };
  return { kind: 'claude-login', model: claude };
}

export function looksLikeClaudeModel(model: string): boolean {
  return /claude|opus|sonnet|haiku/i.test(model);
}

/** The CLI appends `/v1/messages` itself: strip a trailing slash and `/v1`. */
export function normalizeAnthropicBaseUrl(url: string): string {
  return url.replace(/\/+$/, '').replace(/\/v1$/, '');
}

export interface ChildEnvOptions {
  /** e.g. "acc/0.1.0" — identifies us to the CLI (CLAUDE_AGENT_SDK_CLIENT_APP). */
  clientApp?: string;
  /** Allowlist override (tests). */
  allowlist?: readonly string[];
}

function copyAllowed(
  parent: NodeJS.ProcessEnv,
  names: readonly string[],
  out: Record<string, string>,
): void {
  // Windows env names are case-insensitive ("Path"); match case-insensitively everywhere
  // but keep the parent's spelling.
  const wanted = new Set(names.map((n) => n.toUpperCase()));
  for (const [key, value] of Object.entries(parent)) {
    if (value === undefined) continue;
    if (wanted.has(key.toUpperCase())) out[key] = value;
  }
}

/** Only the allowlisted parent vars (for commands that need no model access). */
export function allowlistedEnv(
  parent: NodeJS.ProcessEnv,
  allowlist: readonly string[] = BASE_ENV_ALLOWLIST,
): Record<string, string> {
  const env: Record<string, string> = {};
  copyAllowed(parent, allowlist, env);
  return env;
}

/** Build the agent child's environment: allowlisted parent vars + model routing. */
export function buildChildEnv(
  parent: NodeJS.ProcessEnv,
  routing: ModelRouting,
  opts: ChildEnvOptions = {},
): Record<string, string> {
  const env: Record<string, string> = {};
  copyAllowed(parent, opts.allowlist ?? BASE_ENV_ALLOWLIST, env);
  if (routing.kind === 'claude-login') {
    copyAllowed(parent, CLAUDE_LOGIN_ENV, env);
  } else if (routing.kind === 'anthropic-key') {
    env.ANTHROPIC_API_KEY = routing.apiKey;
    if (routing.model) env.ANTHROPIC_MODEL = routing.model;
  } else {
    env.ANTHROPIC_BASE_URL = routing.baseUrl;
    if (routing.apiKey) env.ANTHROPIC_AUTH_TOKEN = routing.apiKey;
    if (routing.model) {
      env.ANTHROPIC_MODEL = routing.model;
      // Background calls (titles, summaries) and sub-agents would otherwise ask the gateway
      // for Claude's default model names, which a LiteLLM deployment usually does not serve.
      env.ANTHROPIC_DEFAULT_HAIKU_MODEL = routing.model;
      env.CLAUDE_CODE_SUBAGENT_MODEL = routing.model;
    }
    env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = '1';
    // LiteLLM then puts what each streamed request cost on its usage (`usage.cost` of the
    // message_delta): the CLI only knows its own price list, LiteLLM knows the bill.
    env.ANTHROPIC_CUSTOM_HEADERS = `${LITELLM_STREAM_COST_HEADER}: true`;
  }
  // One turn per run: a background sub-agent or command would outlive the turn (killed when
  // the CLI exits, or reported in a notification turn after our result). Observed against
  // the real CLI: with this set, the Agent tool waits for the sub-agent.
  env.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS = '1';
  // cmd.exe would otherwise look a program up in the current directory (the workspace the
  // agent writes) before PATH; with this set it runs one there only when named as `.\x`.
  env.NoDefaultCurrentDirectoryInExePath = '1';
  if (opts.clientApp) env.CLAUDE_AGENT_SDK_CLIENT_APP = opts.clientApp;
  return env;
}

/** Variable names only (safe to log). */
export function envKeys(env: Record<string, string>): string[] {
  return Object.keys(env).sort();
}

/**
 * A program by absolute path, from the absolute PATH entries only. A bare name spawned on
 * Windows is searched in the child's cwd before PATH, and the cwds the daemon spawns in are
 * folders agents write to: a `git.exe` dropped there would run in place of git, outside every
 * tool check. A relative entry (`.`, or `\bin` without a drive) is a cwd again, so it does
 * not count. Windows entries may be quoted. Without an extension on Windows, `.com` then
 * `.exe` (what a spawn would try).
 */
export function findOnPath(
  name: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  isFile: (p: string) => boolean = defaultIsFile,
): string | null {
  const win = platform === 'win32';
  const paths = win ? path.win32 : path.posix;
  const names = win && !paths.extname(name) ? [`${name}.com`, `${name}.exe`] : [name];
  for (const raw of (env.PATH || env.Path || '').split(paths.delimiter)) {
    const dir = win ? raw.replaceAll('"', '').trim() : raw;
    if (!(win ? /^([A-Za-z]:[\\/]|\\\\)/.test(dir) : paths.isAbsolute(dir))) continue;
    for (const n of names) {
      const candidate = paths.join(dir, n);
      if (isFile(candidate)) return candidate;
    }
  }
  return null;
}

function defaultIsFile(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

/** A Windows system program (`taskkill.exe`) by absolute path, never looked up by name. */
export function system32(exe: string, env: NodeJS.ProcessEnv = process.env): string {
  return path.win32.join(env.SystemRoot || env.SYSTEMROOT || 'C:\\Windows', 'System32', exe);
}
