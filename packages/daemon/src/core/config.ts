import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_PORT, type PermissionProfile, Settings, type SettingsView } from '@acc/protocol';
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

export type SettingsPatch = {
  litellm?: { baseUrl?: string | null | undefined; apiKey?: string | null | undefined } | undefined;
  defaultModel?: string | null | undefined;
  defaultRuntime?: string | null | undefined;
  maxConcurrentRuns?: number | undefined;
  maxDelegationDepth?: number | undefined;
  autoResumeOrchestrators?: boolean | undefined;
  llmCallReserveUsd?: number | undefined;
  defaultPermissionProfile?: PermissionProfile | undefined;
  autoMode?:
    { enabled?: boolean | undefined; classifierModel?: string | null | undefined } | undefined;
};

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
    return ConfigFile.parse(raw);
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
    set('defaultRuntime', next.defaultRuntime, patch.defaultRuntime, () => {
      next.defaultRuntime = patch.defaultRuntime ?? null;
    });
    set('maxConcurrentRuns', next.maxConcurrentRuns, patch.maxConcurrentRuns, () => {
      next.maxConcurrentRuns = patch.maxConcurrentRuns!;
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
    if (patch.autoMode) {
      const a = patch.autoMode;
      set('autoMode.enabled', next.autoMode.enabled, a.enabled, () => {
        next.autoMode.enabled = a.enabled!;
      });
      set('autoMode.classifierModel', next.autoMode.classifierModel, a.classifierModel, () => {
        next.autoMode.classifierModel = a.classifierModel ?? null;
      });
    }
    if (changes.length === 0) return changes;
    const valid = ConfigFile.parse(next);
    writeJsonAtomic(this.path, valid);
    this.file = valid;
    return changes;
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
    defaultRuntime: s.defaultRuntime,
    maxConcurrentRuns: s.maxConcurrentRuns,
    maxDelegationDepth: s.maxDelegationDepth,
    autoResumeOrchestrators: s.autoResumeOrchestrators,
    llmCallReserveUsd: s.llmCallReserveUsd,
    defaultPermissionProfile: s.defaultPermissionProfile,
    autoMode: { enabled: s.autoMode.enabled, classifierModel: s.autoMode.classifierModel },
  };
}

export function writeJsonAtomic(path: string, data: unknown, mode = 0o600): void {
  const dir = join(path, '..');
  mkdirSync(dir, { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', { encoding: 'utf8', mode });
  renameSync(tmp, path);
}
