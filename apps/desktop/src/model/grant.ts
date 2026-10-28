import { type CapabilityGrant, type ParamsInput, type Project, matchAnyPattern } from '@acc/protocol';
import { formatClock } from '../lib/format';

/**
 * "権限を与えるだけで Orchestrator になる" (concept §3.1). A chat becomes an orchestrator by
 * holding a capability grant; these presets turn the Control API's permission patterns into
 * a few choices a human can make at a glance. The daemon enforces whatever is granted.
 */

export type GrantPresetId = 'orchestrate' | 'plan' | 'full';

export interface GrantPreset {
  id: GrantPresetId;
  label: string;
  /** One line under the label: what the chat will be able to do. */
  summary: string;
  permissions: string[];
  /** Whether this preset lets the chat start workers (maxWorkers / budget matter). */
  spawns: boolean;
}

const READ = [
  'project.get',
  'session.get',
  'session.list',
  'session.messages',
  'run.get',
  'run.list',
  'task.get',
  'task.list',
  'workspace.get',
  'workspace.list',
  'workspace.diff',
  'artifact.*',
  'integration.get',
  'integration.list',
  'approval.list',
  'events.list',
  'models.list',
  'budget.get',
];

export const GRANT_PRESETS: Record<GrantPresetId, GrantPreset> = {
  orchestrate: {
    id: 'orchestrate',
    label: 'Orchestrator',
    summary: 'Task に分けて Worker を起動し、統合の準備まで進めます',
    permissions: [
      ...READ,
      'task.*',
      'session.create',
      'session.send',
      'run.cancel',
      'run.retry',
      'workspace.create',
      'integration.create',
      'integration.run',
      'grant.create',
      'budget.allocate',
      'budget.release',
    ],
    spawns: true,
  },
  plan: {
    id: 'plan',
    label: '計画のみ',
    summary: 'Task の作成と整理だけを行います。Worker は起動しません',
    permissions: [...READ, 'task.create', 'task.update', 'task.cancel'],
    spawns: false,
  },
  full: {
    id: 'full',
    label: 'すべての操作',
    summary: 'Control API のすべてを使えます（統合の反映だけは常にあなたが行います）',
    permissions: ['*'],
    spawns: true,
  },
};

export const PRESET_ORDER: GrantPresetId[] = ['orchestrate', 'plan', 'full'];

export type LifetimeChoice = 'run' | 'session';

export const LIFETIME_LABEL: Record<LifetimeChoice, string> = {
  run: 'この実行のみ',
  session: 'このセッション',
};

/** Session grants expire; these are the offered lengths (null = until revoked). */
export const EXPIRY_CHOICES: { ms: number | null; label: string }[] = [
  { ms: 3600_000, label: '1 時間' },
  { ms: 8 * 3600_000, label: '8 時間' },
  { ms: 24 * 3600_000, label: '24 時間' },
  { ms: null, label: '期限なし' },
];

export interface OrchestratorGrantInput {
  sessionId: string;
  projectId: string | null;
  preset: GrantPresetId;
  maxWorkers: number;
  /** Budget the chat may hand out to workers; null = no budget pool. */
  budgetUsd: number | null;
  lifetime: LifetimeChoice;
  /** Only for lifetime "session". */
  expiresInMs: number | null;
}

export const DEFAULT_GRANT_INPUT: Omit<OrchestratorGrantInput, 'sessionId' | 'projectId'> = {
  preset: 'orchestrate',
  maxWorkers: 2,
  budgetUsd: 5,
  lifetime: 'run',
  expiresInMs: 8 * 3600_000,
};

export const MAX_WORKERS_LIMIT = 8;

/** grant.create params for the dialog's choices. Workers can never delegate further (depth 1). */
export function grantParams(input: OrchestratorGrantInput, now: number): ParamsInput<'grant.create'> {
  const preset = GRANT_PRESETS[input.preset];
  return {
    subject: { kind: 'session', sessionId: input.sessionId },
    permissions: preset.permissions,
    scope: input.projectId ? { projectIds: [input.projectId] } : {},
    limits: preset.spawns ? { maxWorkers: input.maxWorkers, maxDepth: 1 } : { maxWorkers: 0, maxDepth: 0 },
    lifetime: input.lifetime,
    ...(input.lifetime === 'session' && input.expiresInMs
      ? { expiresAt: new Date(now + input.expiresInMs).toISOString() }
      : {}),
    reason: `Orchestrator（${preset.label}）としての権限をデスクトップから付与`,
  };
}

export function isGrantActive(g: CapabilityGrant, nowIso: string): boolean {
  return !g.revokedAt && (!g.expiresAt || g.expiresAt > nowIso);
}

export function activeGrants(grants: readonly CapabilityGrant[], nowIso: string): CapabilityGrant[] {
  return grants.filter((g) => isGrantActive(g, nowIso));
}

/** The preset a grant was made from (exact permission set), or null for custom grants. */
export function presetOf(g: CapabilityGrant): GrantPresetId | null {
  const key = [...g.permissions].sort().join(',');
  for (const id of PRESET_ORDER) {
    if ([...GRANT_PRESETS[id].permissions].sort().join(',') === key) return id;
  }
  return null;
}

/** Whether a grant lets its holder act as an orchestrator (create tasks or start workers). */
export function canOrchestrate(g: CapabilityGrant): boolean {
  return matchAnyPattern(g.permissions, 'task.create') || matchAnyPattern(g.permissions, 'task.spawnWorker');
}

const CAPABILITY_LINES: { method: string; label: string }[] = [
  { method: 'task.create', label: 'Task の作成・更新' },
  { method: 'task.spawnWorker', label: 'Worker の起動（worktree を作成）' },
  { method: 'session.send', label: 'ほかのセッションへの指示' },
  { method: 'integration.run', label: '統合ブランチの作成とテスト' },
  { method: 'budget.allocate', label: '予算の配分' },
  { method: 'grant.create', label: 'Worker への権限の委譲' },
  { method: 'settings.update', label: '設定の変更' },
];

/** Human-readable list of what a permission set allows. */
export function capabilityLines(permissions: readonly string[]): string[] {
  return CAPABILITY_LINES.filter((c) => matchAnyPattern(permissions, c.method)).map((c) => c.label);
}

export interface GrantView {
  id: string;
  /** Chip title: `Orchestrator` / `計画のみ` / `すべての操作` / `カスタム権限`. */
  title: string;
  /** Not one of the presets (made by the CLI, an agent or an older version). */
  custom: boolean;
  /** `この実行のみ` / `14:30 まで` / `このセッション`. */
  lifetime: string;
  /** `Worker 2 人まで` (null when it cannot start workers). */
  workers: string | null;
  /** Project names the grant is limited to; null = all projects. */
  projects: string[] | null;
  capabilities: string[];
  orchestrates: boolean;
  delegated: boolean;
}

export function describeGrant(g: CapabilityGrant, projects: readonly Project[] = []): GrantView {
  const preset = presetOf(g);
  const canSpawn = matchAnyPattern(g.permissions, 'task.spawnWorker');
  const lifetime =
    g.lifetime === 'run'
      ? LIFETIME_LABEL.run
      : g.expiresAt
        ? `${formatClock(g.expiresAt)} まで`
        : LIFETIME_LABEL.session;
  const workers =
    canSpawn && g.limits.maxWorkers !== 0
      ? g.limits.maxWorkers == null
        ? 'Worker 上限なし'
        : `Worker ${g.limits.maxWorkers} 人まで`
      : null;
  const ids = g.scope.projectIds;
  // A grant that can start workers makes its holder an Orchestrator, preset or not.
  const title = preset
    ? GRANT_PRESETS[preset].label
    : g.parentGrantId
      ? '委譲された権限'
      : canSpawn
        ? 'Orchestrator'
        : canOrchestrate(g)
          ? GRANT_PRESETS.plan.label
          : 'カスタム権限';
  return {
    id: g.id,
    title,
    custom: !preset,
    lifetime,
    workers,
    projects: ids ? ids.map((id) => projects.find((p) => p.id === id)?.name ?? id) : null,
    capabilities: capabilityLines(g.permissions),
    orchestrates: canOrchestrate(g),
    delegated: g.parentGrantId !== null,
  };
}
