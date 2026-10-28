import { AccClientError } from '@acc/client';
import type { ModelInfo, Project, Session } from '@acc/protocol';
import { createSession } from '../daemon/actions';
import { isNotImplemented } from '../daemon/errors';
import { qk } from '../daemon/keys';
import { grantOrchestrator } from '../daemon/orchestration';
import type { AppRuntime } from '../daemon/runtime';
import { activeGrants, canOrchestrate } from '../model/grant';
import { toastError } from '../store/toast';
import { useUi } from '../store/ui';
import { focusComposerSoon } from './commands';

/** The first message the demo suggests (one click sends it; never auto-sent). */
export const DEMO_MESSAGE = '認証まわりのドキュメントとテストを並列で整備して';
export const DEMO_SESSION_TITLE = '設計チャット';

/** Demo setup methods a daemon may offer (it can create a sample git repo; the UI cannot). */
export const DEMO_SETUP_METHODS = ['system.setupDemo', 'demo.setup', 'system.demo'] as const;

/** Mock models, best demo experience first (a scripted orchestrator beats plain echo). */
const DEMO_MODEL_PREFERENCE = ['mock/orchestrator', 'mock/demo', 'mock/echo'];

export function pickDemoModel(models: readonly ModelInfo[]): string | null {
  for (const id of DEMO_MODEL_PREFERENCE) if (models.some((m) => m.id === id)) return id;
  return models.find((m) => m.id.startsWith('mock/'))?.id ?? null;
}

interface DemoSetupResult {
  sessionId?: string;
  session?: { id?: string };
  projectId?: string;
  project?: { id?: string };
  grant?: unknown;
  suggestedMessage?: string;
  message?: string;
}

/** Read ids out of whatever shape the daemon's demo method returns. */
export function parseDemoResult(raw: unknown): {
  sessionId: string | null;
  projectId: string | null;
  message: string | null;
  /** The setup already granted the orchestrator capability. */
  granted: boolean;
} {
  const r = (raw && typeof raw === 'object' ? raw : {}) as DemoSetupResult;
  const str = (v: unknown) => (typeof v === 'string' && v ? v : null);
  return {
    sessionId: str(r.sessionId) ?? str(r.session?.id),
    projectId: str(r.projectId) ?? str(r.project?.id),
    message: str(r.suggestedMessage) ?? str(r.message),
    granted: !!r.grant && typeof r.grant === 'object',
  };
}

type UntypedCall = (method: string, params: unknown) => Promise<unknown>;

/**
 * "デモモードで試す" (§8.1): one click lands in the demo design chat, already holding the
 * orchestrator grant, with the first message suggested. Uses the daemon's demo setup when
 * it has one (sample repository, project, chat); otherwise sets up the chat client-side.
 */
export async function startDemo(
  rt: AppRuntime,
  methods: ReadonlySet<string> | null,
): Promise<Session | null> {
  const qc = rt.queryClient;
  const ui = useUi.getState();
  let sessionId: string | null = null;
  let projectId: string | null = null;
  let message = DEMO_MESSAGE;
  let granted = false;

  // Probe: the methods system.info lists, or (not loaded yet) simply try each in turn.
  const candidates = methods ? DEMO_SETUP_METHODS.filter((m) => methods.has(m)) : DEMO_SETUP_METHODS;
  const call = rt.client.call.bind(rt.client) as unknown as UntypedCall;
  for (const setup of candidates) {
    try {
      const res = parseDemoResult(await call(setup, {}));
      sessionId = res.sessionId;
      projectId = res.projectId;
      granted = res.granted;
      if (res.message) message = res.message;
      await Promise.all([
        qc.invalidateQueries({ queryKey: qk.sessions }),
        qc.invalidateQueries({ queryKey: qk.projects }),
      ]);
      break;
    } catch (err) {
      if (isNotImplemented(err) || (err instanceof AccClientError && err.code === 'not_found')) continue;
      toastError(err, 'デモを準備できませんでした');
      break;
    }
  }

  if (!sessionId) {
    const projects =
      qc.getQueryData<Project[]>(qk.projects) ??
      (await rt.client
        .call('project.list', {})
        .then((r) => r.items)
        .catch(() => []));
    const project =
      projects.find((p) => p.id === ui.projectId) ??
      projects.find((p) => /demo|デモ/i.test(p.name)) ??
      projects[0] ??
      null;
    projectId = project?.id ?? null;
    const models = await rt
      .callOr('models.list', {}, { models: [], source: 'config' })
      .catch(() => ({ models: [] as ModelInfo[] }));
    const s = await createSession(rt, {
      kind: 'chat',
      title: DEMO_SESSION_TITLE,
      projectId,
      model: pickDemoModel(models.models),
    });
    if (!s) return null;
    sessionId = s.id;
  }

  // Make sure the chat holds the orchestrator grant (the demo's point, concept §3.1).
  const grants = granted
    ? []
    : await rt
        .callOr('grant.list', { sessionId }, { items: [] })
        .then((r) => r.items)
        .catch(() => []);
  if (granted) {
    void qc.invalidateQueries({ queryKey: qk.grants(sessionId) });
  } else if (!activeGrants(grants, new Date().toISOString()).some(canOrchestrate)) {
    await grantOrchestrator(
      rt,
      {
        sessionId,
        projectId,
        preset: 'orchestrate',
        maxWorkers: 2,
        budgetUsd: 5,
        lifetime: 'session',
        expiresInMs: 8 * 3600_000,
      },
      methods,
    );
  } else {
    void qc.invalidateQueries({ queryKey: qk.grants(sessionId) });
  }

  if (projectId) ui.setProject(projectId);
  ui.setSuggestion(sessionId, message);
  ui.finishOnboarding();
  ui.openSession(sessionId);
  focusComposerSoon();
  const sessions = qc.getQueryData<Session[]>(qk.sessions);
  return sessions?.find((s) => s.id === sessionId) ?? null;
}
