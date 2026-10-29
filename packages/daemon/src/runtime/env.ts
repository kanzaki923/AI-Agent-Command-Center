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
  | { kind: 'claude-login'; model: string | null };

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
  return { kind: 'claude-login', model: m && looksLikeClaudeModel(m) ? m : null };
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
  }
  // One turn per run: a background sub-agent or command would outlive the turn (killed when
  // the CLI exits, or reported in a notification turn after our result). Observed against
  // the real CLI: with this set, the Agent tool waits for the sub-agent.
  env.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS = '1';
  if (opts.clientApp) env.CLAUDE_AGENT_SDK_CLIENT_APP = opts.clientApp;
  return env;
}

/** Variable names only (safe to log). */
export function envKeys(env: Record<string, string>): string[] {
  return Object.keys(env).sort();
}
