import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  type AutoModeJudge,
  type ChatGptCredentials,
  DEFAULT_PORT,
  type ModelRule,
  type PermissionProfile,
  Settings,
  type SettingsView,
} from '@acc/protocol';
import { z } from 'zod';

export interface DaemonPaths {
  home: string;
  db: string;
  config: string;
  daemonInfo: string;
  worktrees: string;
}

/** `$ACC_HOME` (default `~/.acc`) and the files inside it. */
export function resolvePaths(home?: string, env: NodeJS.ProcessEnv = process.env): DaemonPaths {
  const root = home ?? env.ACC_HOME ?? join(homedir(), '.acc');
  return {
    home: root,
    db: join(root, 'acc.sqlite'),
    config: join(root, 'config.json'),
    daemonInfo: join(root, 'daemon.json'),
    worktrees: join(root, 'worktrees'),
  };
}

/** config.json = Settings + daemon-only options. Unknown keys are preserved on write. */
export const ConfigFile = Settings.extend({
  port: z.int().min(0).max(65535).optional(),
}).loose();
export type ConfigFile = z.infer<typeof ConfigFile>;

export function resolvePort(
  explicit: number | undefined,
  config: ConfigFile,
  env: NodeJS.ProcessEnv,
): number {
  if (explicit !== undefined) return explicit;
  if (env.ACC_PORT) {
    const n = Number(env.ACC_PORT);
    if (!Number.isInteger(n) || n < 0 || n > 65535)
      throw new Error(`Invalid ACC_PORT: ${env.ACC_PORT}`);
    return n;
  }
  return config.port ?? DEFAULT_PORT;
}

/**
 * Settings renamed by the session-tree redesign read their older names when the new one is
 * absent: maxConcurrentRuns → maxConcurrentAgents, autoResumeOrchestrators → autoResume.
 */
export function withLegacySettings(raw: unknown): unknown {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return raw;
  const r = raw as Record<string, unknown>;
  const out: Record<string, unknown> = { ...r };
  if (r.maxConcurrentAgents === undefined && r.maxConcurrentRuns !== undefined) {
    out.maxConcurrentAgents = r.maxConcurrentRuns;
  }
  if (r.autoResume === undefined && r.autoResumeOrchestrators !== undefined) {
    out.autoResume = r.autoResumeOrchestrators;
  }
  return out;
}

export type SettingsPatch = {
  litellm?: { baseUrl?: string | null | undefined; apiKey?: string | null | undefined } | undefined;
  defaultModel?: string | null | undefined;
  modelRules?: ModelRule[] | undefined;
  defaultRuntime?: string | null | undefined;
  maxConcurrentRuns?: number | undefined;
  maxConcurrentAgents?: number | undefined;
  maxConcurrentChats?: number | undefined;
  limits?: { dailyUsd?: number | null | undefined; timezone?: string | undefined } | undefined;
  maxDelegationDepth?: number | undefined;
  autoResumeOrchestrators?: boolean | undefined;
  autoResume?: boolean | undefined;
  llmCallReserveUsd?: number | undefined;
  defaultPermissionProfile?: PermissionProfile | undefined;
  autoMode?:
    | {
        enabled?: boolean | undefined;
        judge?: AutoModeJudge | undefined;
        classifierModel?: string | null | undefined;
        classifierCostUsd?: number | undefined;
      }
    | undefined;
  assistant?:
    | {
        model?: string | null | undefined;
        dailyUsd?: number | null | undefined;
        characterId?: string | null | undefined;
      }
    | undefined;
  members?: { memory?: boolean | undefined } | undefined;
  summaries?: { enabled?: boolean | undefined } | undefined;
  background?:
    | { model?: string | null | undefined; dailyUsd?: number | null | undefined }
    | undefined;
  providers?:
    | {
        anthropic?:
          { apiKey?: string | null | undefined; baseUrl?: string | null | undefined } | undefined;
        openai?:
          { apiKey?: string | null | undefined; baseUrl?: string | null | undefined } | undefined;
      }
    | undefined;
};

/** Whether any model provider is set up (else chats fall back to the offline mocks). */
export function isLlmConfigured(s: Settings): boolean {
  return !!(
    s.litellm.baseUrl ||
    s.providers.anthropic.apiKey ||
    s.providers.openai.apiKey ||
    s.providers.openai.chatgpt
  );
}

/**
 * Settings persisted in config.json. Environment overrides (not persisted):
 * `ACC_LITELLM_BASE_URL`, `ACC_LITELLM_API_KEY`.
 */
export class SettingsStore {
  private file: ConfigFile;

  constructor(
    private readonly path: string,
    private readonly env: NodeJS.ProcessEnv = process.env,
  ) {
    this.file = SettingsStore.read(path);
  }

  static read(path: string): ConfigFile {
    let raw: unknown = {};
    try {
      raw = JSON.parse(readFileSync(path, 'utf8'));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw new Error(`Failed to read ${path}: ${(err as Error).message}`, { cause: err });
      }
    }
    return ConfigFile.parse(withLegacySettings(raw));
  }

  /** Effective settings including env overrides. Contains secrets: never return to clients. */
  get(): Settings {
    const s = Settings.parse(this.file);
    return {
      ...s,
      litellm: {
        baseUrl: this.env.ACC_LITELLM_BASE_URL || s.litellm.baseUrl,
        apiKey: this.env.ACC_LITELLM_API_KEY || s.litellm.apiKey,
      },
    };
  }

  config(): ConfigFile {
    return this.file;
  }

  view(): SettingsView {
    return toSettingsView(this.get());
  }

  /** Apply a patch and persist atomically. Returns changed keys (dot paths). */
  update(patch: SettingsPatch): string[] {
    const next: ConfigFile = structuredClone(this.file);
    const changes: string[] = [];
    const set = <K extends string>(key: K, cur: unknown, val: unknown, apply: () => void) => {
      if (val === undefined || cur === val) return;
      apply();
      changes.push(key);
    };
    if (patch.litellm) {
      const l = patch.litellm;
      set('litellm.baseUrl', next.litellm.baseUrl, l.baseUrl, () => {
        next.litellm.baseUrl = l.baseUrl ?? null;
      });
      set('litellm.apiKey', next.litellm.apiKey, l.apiKey, () => {
        next.litellm.apiKey = l.apiKey ?? null;
      });
    }
    set('defaultModel', next.defaultModel, patch.defaultModel, () => {
      next.defaultModel = patch.defaultModel ?? null;
    });
    if (
      patch.modelRules &&
      JSON.stringify(patch.modelRules) !== JSON.stringify(next.modelRules)
    ) {
      next.modelRules = patch.modelRules.map((r) => ({ model: r.model, when: r.when.trim() }));
      changes.push('modelRules');
    }
    set('defaultRuntime', next.defaultRuntime, patch.defaultRuntime, () => {
      next.defaultRuntime = patch.defaultRuntime ?? null;
    });
    set('maxConcurrentRuns', next.maxConcurrentRuns, patch.maxConcurrentRuns, () => {
      next.maxConcurrentRuns = patch.maxConcurrentRuns!;
    });
    set('maxConcurrentAgents', next.maxConcurrentAgents, patch.maxConcurrentAgents, () => {
      next.maxConcurrentAgents = patch.maxConcurrentAgents!;
    });
    set('maxConcurrentChats', next.maxConcurrentChats, patch.maxConcurrentChats, () => {
      next.maxConcurrentChats = patch.maxConcurrentChats!;
    });
    if (patch.limits) {
      const l = patch.limits;
      set('limits.dailyUsd', next.limits.dailyUsd, l.dailyUsd, () => {
        next.limits.dailyUsd = l.dailyUsd ?? null;
      });
      set('limits.timezone', next.limits.timezone, l.timezone, () => {
        next.limits.timezone = l.timezone!;
      });
    }
    set('autoResume', next.autoResume, patch.autoResume, () => {
      next.autoResume = patch.autoResume!;
    });
    set('maxDelegationDepth', next.maxDelegationDepth, patch.maxDelegationDepth, () => {
      next.maxDelegationDepth = patch.maxDelegationDepth!;
    });
    set(
      'autoResumeOrchestrators',
      next.autoResumeOrchestrators,
      patch.autoResumeOrchestrators,
      () => {
        next.autoResumeOrchestrators = patch.autoResumeOrchestrators!;
      },
    );
    set('llmCallReserveUsd', next.llmCallReserveUsd, patch.llmCallReserveUsd, () => {
      next.llmCallReserveUsd = patch.llmCallReserveUsd!;
    });
    set(
      'defaultPermissionProfile',
      next.defaultPermissionProfile,
      patch.defaultPermissionProfile,
      () => {
        next.defaultPermissionProfile = patch.defaultPermissionProfile!;
      },
    );
    if (patch.providers?.anthropic) {
      const a = patch.providers.anthropic;
      set('providers.anthropic.apiKey', next.providers.anthropic.apiKey, a.apiKey, () => {
        next.providers.anthropic.apiKey = a.apiKey ?? null;
      });
      set('providers.anthropic.baseUrl', next.providers.anthropic.baseUrl, a.baseUrl, () => {
        next.providers.anthropic.baseUrl = a.baseUrl ?? null;
      });
    }
    if (patch.providers?.openai) {
      const o = patch.providers.openai;
      set('providers.openai.apiKey', next.providers.openai.apiKey, o.apiKey, () => {
        next.providers.openai.apiKey = o.apiKey ?? null;
      });
      set('providers.openai.baseUrl', next.providers.openai.baseUrl, o.baseUrl, () => {
        next.providers.openai.baseUrl = o.baseUrl ?? null;
      });
    }
    if (patch.assistant) {
      const a = patch.assistant;
      set('assistant.model', next.assistant.model, a.model, () => {
        next.assistant.model = a.model ?? null;
      });
      set('assistant.dailyUsd', next.assistant.dailyUsd, a.dailyUsd, () => {
        next.assistant.dailyUsd = a.dailyUsd ?? null;
      });
      set('assistant.characterId', next.assistant.characterId, a.characterId, () => {
        next.assistant.characterId = a.characterId ?? null;
      });
    }
    if (patch.members) {
      const m = patch.members;
      set('members.memory', next.members.memory, m.memory, () => {
        next.members.memory = m.memory ?? true;
      });
    }
    if (patch.summaries) {
      const m = patch.summaries;
      set('summaries.enabled', next.summaries.enabled, m.enabled, () => {
        next.summaries.enabled = m.enabled ?? true;
      });
    }
    if (patch.background) {
      const b = patch.background;
      set('background.model', next.background.model, b.model, () => {
        next.background.model = b.model ?? null;
      });
      set('background.dailyUsd', next.background.dailyUsd, b.dailyUsd, () => {
        next.background.dailyUsd = b.dailyUsd ?? null;
      });
    }
    if (patch.autoMode) {
      const a = patch.autoMode;
      set('autoMode.enabled', next.autoMode.enabled, a.enabled, () => {
        next.autoMode.enabled = a.enabled!;
      });
      set('autoMode.judge', next.autoMode.judge, a.judge, () => {
        next.autoMode.judge = a.judge!;
      });
      set('autoMode.classifierModel', next.autoMode.classifierModel, a.classifierModel, () => {
        next.autoMode.classifierModel = a.classifierModel ?? null;
      });
      set(
        'autoMode.classifierCostUsd',
        next.autoMode.classifierCostUsd,
        a.classifierCostUsd,
        () => {
          next.autoMode.classifierCostUsd = a.classifierCostUsd!;
        },
      );
    }
    if (changes.length === 0) return changes;
    const valid = ConfigFile.parse(next);
    writeJsonAtomic(this.path, valid);
    this.file = valid;
    return changes;
  }

  /** The ChatGPT sign-in (secrets), or null. */
  chatgpt(): ChatGptCredentials | null {
    return this.get().providers.openai.chatgpt;
  }

  /** Store (or forget) the ChatGPT sign-in. */
  setChatGpt(credentials: ChatGptCredentials | null): void {
    const next: ConfigFile = structuredClone(this.file);
    next.providers.openai.chatgpt = credentials;
    const valid = ConfigFile.parse(next);
    writeJsonAtomic(this.path, valid);
    this.file = valid;
  }

  /** The stable host id for ChatGPT registration, made on first use (`make` gives a new one). */
  chatgptHostId(make: () => string): string {
    const cur = this.file.providers.openai.chatgptHostId;
    if (cur) return cur;
    const next: ConfigFile = structuredClone(this.file);
    next.providers.openai.chatgptHostId = make();
    const valid = ConfigFile.parse(next);
    writeJsonAtomic(this.path, valid);
    this.file = valid;
    return valid.providers.openai.chatgptHostId!;
  }
}

export function maskSecret(secret: string | null): string | null {
  if (!secret) return null;
  if (secret.length < 12) return '••••';
  const head = secret.startsWith('sk-') ? 'sk-' : '';
  return `${head}…${secret.slice(-4)}`;
}

export function toSettingsView(s: Settings): SettingsView {
  return {
    litellm: {
      baseUrl: s.litellm.baseUrl,
      hasApiKey: !!s.litellm.apiKey,
      apiKeyMasked: maskSecret(s.litellm.apiKey),
    },
    defaultModel: s.defaultModel,
    modelRules: s.modelRules.map((r) => ({ ...r })),
    defaultRuntime: s.defaultRuntime,
    maxConcurrentRuns: s.maxConcurrentRuns,
    maxConcurrentAgents: s.maxConcurrentAgents,
    maxConcurrentChats: s.maxConcurrentChats,
    limits: { dailyUsd: s.limits.dailyUsd, timezone: s.limits.timezone },
    maxDelegationDepth: s.maxDelegationDepth,
    autoResumeOrchestrators: s.autoResumeOrchestrators,
    autoResume: s.autoResume,
    supervisor: { ...s.supervisor },
    assistant: { ...s.assistant },
    members: { ...s.members },
    summaries: { ...s.summaries },
    background: { ...s.background },
    providers: {
      anthropic: {
        baseUrl: s.providers.anthropic.baseUrl,
        hasApiKey: !!s.providers.anthropic.apiKey,
        apiKeyMasked: maskSecret(s.providers.anthropic.apiKey),
      },
      openai: {
        baseUrl: s.providers.openai.baseUrl,
        hasApiKey: !!s.providers.openai.apiKey,
        apiKeyMasked: maskSecret(s.providers.openai.apiKey),
        chatgpt: s.providers.openai.chatgpt ? { email: s.providers.openai.chatgpt.email } : null,
      },
    },
    llmCallReserveUsd: s.llmCallReserveUsd,
    defaultPermissionProfile: s.defaultPermissionProfile,
    autoMode: {
      enabled: s.autoMode.enabled,
      judge: s.autoMode.judge,
      classifierModel: s.autoMode.classifierModel,
      classifierCostUsd: s.autoMode.classifierCostUsd,
    },
  };
}

export function writeJsonAtomic(path: string, data: unknown, mode = 0o600): void {
  const dir = join(path, '..');
  mkdirSync(dir, { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', { encoding: 'utf8', mode });
  renameSync(tmp, path);
}
