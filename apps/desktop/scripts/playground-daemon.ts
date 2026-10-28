/**
 * UI playground daemon (dev only): the REAL Core Daemon (all default modules) plus a
 * `ui-playground` module that
 *   1. fills Control API methods other modules have not implemented yet with in-memory /
 *      repo-backed stand-ins (registered only when missing, so real implementations win), and
 *   2. seeds a realistic multi-agent scene and keeps it alive with live events + deltas.
 *
 * It exists to drive the desktop UI visually (Playwright screenshots, manual QA) before the
 * runs / llm / runtime / integration modules land. Never used by the app at runtime.
 *
 *   ACC_HOME=<tmp dir> ACC_PORT=47899 pnpm --filter @acc/desktop playground
 *
 * Env: ACC_HOME (default: a fresh temp dir), ACC_PORT (default 47899), PLAYGROUND_LIVE=0
 * disables the background simulation (stable screenshots).
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  Actor,
  AgentActor,
  Approval,
  Artifact,
  CapabilityGrant,
  ContentPart,
  Integration,
  Message,
  Project,
  Run,
  RunStatus,
  Session,
  Task,
  Workspace,
} from '@acc/protocol';
import { type AnyMethodImpl, defineMethod } from '../../../packages/daemon/src/api/registry';
import type { Clock } from '../../../packages/daemon/src/core/clock';
import type { DaemonContext } from '../../../packages/daemon/src/core/context';
import { ApiError } from '../../../packages/daemon/src/core/errors';
import { createLogger, parseLogLevel } from '../../../packages/daemon/src/core/log';
import { startDaemon } from '../../../packages/daemon/src/daemon';
import { defineModule } from '../../../packages/daemon/src/module';
import { modules as defaultModules } from '../../../packages/daemon/src/modules';

// node:sqlite prints an ExperimentalWarning on load; expected.
const originalEmitWarning = process.emitWarning.bind(process);
process.emitWarning = (warning: string | Error, ...rest: unknown[]) => {
  const msg = typeof warning === 'string' ? warning : warning.message;
  if (msg.includes('SQLite is an experimental feature')) return;
  (originalEmitWarning as (...a: unknown[]) => void)(warning, ...rest);
};

/** Clock that can be wound back while seeding, so the scene has a believable history. */
function createSeedClock(): Clock & { at(ms: number | null): void } {
  let fixed: number | null = null;
  return {
    now: () => fixed ?? Date.now(),
    iso: () => new Date(fixed ?? Date.now()).toISOString(),
    at: (ms) => {
      fixed = ms;
    },
  };
}

const HUMAN: Actor = { kind: 'human', client: 'desktop' };
const SYSTEM: Actor = { kind: 'system', component: 'playground' };
const MIN = 60_000;

const PATCH = `diff --git a/src/auth/session.ts b/src/auth/session.ts
index 3f2a1c0..9b7e4d2 100644
--- a/src/auth/session.ts
+++ b/src/auth/session.ts
@@ -12,14 +12,32 @@ export interface Session {
   userId: string;
   expiresAt: number;
 }

-export function isExpired(session: Session): boolean {
-  return Date.now() > session.expiresAt;
+/** Grace period before we ask the user to sign in again. */
+const REAUTH_GRACE_MS = 60_000;
+
+export function isExpired(session: Session, now = Date.now()): boolean {
+  return now > session.expiresAt;
+}
+
+export function needsReauth(session: Session, now = Date.now()): boolean {
+  return now > session.expiresAt - REAUTH_GRACE_MS;
 }

 export async function refresh(session: Session): Promise<Session> {
-  const res = await fetch('/api/session/refresh');
-  return res.json();
+  const res = await fetch('/api/session/refresh', { credentials: 'include' });
+  if (res.status === 401) {
+    throw new ReauthRequiredError(session.userId);
+  }
+  return (await res.json()) as Session;
+}
+
+export class ReauthRequiredError extends Error {
+  constructor(readonly userId: string) {
+    super('Session expired; sign in again');
+  }
 }
diff --git a/src/auth/LoginPrompt.tsx b/src/auth/LoginPrompt.tsx
new file mode 100644
--- /dev/null
+++ b/src/auth/LoginPrompt.tsx
@@ -0,0 +1,14 @@
+import { useSession } from './useSession';
+
+export function LoginPrompt() {
+  const { session, reauth } = useSession();
+  if (!session?.needsReauth) return null;
+  return (
+    <div role="alertdialog" aria-label="再ログイン">
+      <p>セッションの有効期限が切れました。もう一度ログインしてください。</p>
+      <button type="button" onClick={reauth}>
+        ログイン
+      </button>
+    </div>
+  );
+}
diff --git a/src/auth/useSession.ts b/src/auth/useSession.ts
--- a/src/auth/useSession.ts
+++ b/src/auth/useSession.ts
@@ -4,6 +4,12 @@ export function useSession() {
   const [session, setSession] = useState<Session | null>(null);
-  return { session };
+  const reauth = useCallback(() => {
+    window.location.assign('/login?return=' + encodeURIComponent(location.pathname));
+  }, []);
+  return {
+    session: session && { ...session, needsReauth: needsReauth(session) },
+    reauth,
+  };
 }
`;

const AUTH_REPLY = `期限切れを検知したら、API 呼び出しの直前ではなく **有効期限の 60 秒前** に再ログインを促すようにしました。

変更点は次の 3 つです。

1. \`needsReauth()\` を追加し、猶予時間（\`REAUTH_GRACE_MS\`）を持たせました
2. \`refresh()\` が 401 を受けたら \`ReauthRequiredError\` を投げます
3. 新しい \`LoginPrompt\` コンポーネントで、モーダルではなく画面上部に控えめに表示します

\`\`\`ts
export function needsReauth(session: Session, now = Date.now()): boolean {
  return now > session.expiresAt - REAUTH_GRACE_MS;
}
\`\`\`

次にテストを追加して、境界値（ちょうど 60 秒前）の挙動を確認します。`;

const CHAT_REPLY = `了解しました。要点を整理します。

## 方針

- まず **現状の計測** をして、ボトルネックを特定します
- 変更は小さく分け、それぞれにテストを付けます

| 項目 | 現状 | 目標 |
|---|---|---|
| 初回表示 | 1.8s | 0.8s |
| 再描画 | 42ms | 16ms |

\`\`\`bash
pnpm build && pnpm test --run
\`\`\`

ほかに優先したい観点があれば教えてください。`;

function playgroundModule(clock: ReturnType<typeof createSeedClock>, live: boolean) {
  return defineModule({
    name: 'ui-playground',
    register(ctx: DaemonContext) {
      const { repos, bus } = ctx;
      const reg = (impl: AnyMethodImpl) => {
        if (!ctx.methods.has(impl.name)) ctx.methods.register(impl);
      };
      const timers: ReturnType<typeof setInterval>[] = [];
      const iso = (ms: number) => new Date(ms).toISOString();

      // ---------------------------------------------------------------- stand-in methods
      reg(
        defineMethod('run.list', {
          handler: (p) =>
            repos.runs.page({
              where: {
                session_id: p.sessionId,
                task_id: p.taskId,
                project_id: p.projectId,
                kind: p.kind,
                ...(p.status ? { status: p.status } : {}),
              },
              orderBy: 'created_at',
              direction: 'desc',
              limit: p.limit,
              cursor: p.cursor,
            }),
        }),
      );
      reg(
        defineMethod('approval.list', {
          handler: (p) =>
            repos.approvals.page({
              where: {
                project_id: p.projectId,
                session_id: p.sessionId,
                run_id: p.runId,
                ...(p.status ? { status: p.status } : {}),
              },
              orderBy: 'created_at',
              direction: 'desc',
              limit: p.limit,
              cursor: p.cursor,
            }),
        }),
      );
      const setRunStatus = (runId: string, to: RunStatus, actor: Actor, reason: string | null = null) => {
        const cur = repos.runs.require(runId);
        const now = clock.iso();
        const terminal = ['completed', 'failed', 'cancelled', 'interrupted'].includes(to);
        const next = repos.runs.update(runId, (r) => ({
          ...r,
          status: to,
          statusReason: reason,
          updatedAt: now,
          startedAt: r.startedAt ?? (to === 'running' ? now : null),
          endedAt: terminal ? now : null,
        }));
        bus.emit({ type: 'run.status_changed', actor, payload: { runId, from: cur.status, to, reason }, refs: { sessionId: cur.sessionId, projectId: cur.projectId, taskId: cur.taskId } });
        if (terminal) {
          repos.sessions.update(cur.sessionId, (s) => (s.activeRunId === runId ? { ...s, activeRunId: null, updatedAt: now } : s));
        }
        return next;
      };
      reg(
        defineMethod('approval.respond', {
          handler: (p, call) => {
            const a = repos.approvals.require(p.approvalId);
            if (a.status !== 'pending') throw new ApiError('conflict', 'この承認はすでに処理されています');
            const resolved = ctx.db.transaction(() => {
              const next = repos.approvals.update(a.id, (x) => ({
                ...x,
                status: p.decision === 'approve' ? 'approved' : 'rejected',
                resolvedBy: call.actor,
                resolvedAt: clock.iso(),
                resolutionNote: p.note ?? null,
              }));
              bus.emit({ type: 'approval.resolved', actor: call.actor, payload: { approval: next } });
              return next;
            });
            if (a.runId) {
              const runId = a.runId;
              setTimeout(() => {
                ctx.db.transaction(() => setRunStatus(runId, 'running', SYSTEM));
                if (p.decision === 'approve') {
                  const toolCallId = `tc_${Date.now()}`;
                  bus.emit({ type: 'tool.called', actor: SYSTEM, payload: { runId, toolCallId, name: 'Bash', input: (a.payload as { input?: unknown }).input ?? {} }, refs: { sessionId: a.sessionId } });
                }
              }, 700);
            }
            return resolved;
          },
        }),
      );
      reg(
        defineMethod('run.cancel', {
          handler: (p, call) => ctx.db.transaction(() => setRunStatus(p.runId, 'cancelled', call.actor, p.reason ?? 'user')),
        }),
      );
      reg(
        defineMethod('run.retry', {
          handler: (p, call) =>
            ctx.db.transaction(() => {
              const prev = repos.runs.require(p.runId);
              const now = clock.iso();
              const run = repos.runs.insert({
                ...prev,
                id: ctx.ids.next('run'),
                status: 'running',
                statusReason: null,
                retryOfRunId: prev.id,
                attempt: prev.attempt + 1,
                error: null,
                usage: { inputTokens: 0, outputTokens: 0, costUsd: 0, costSource: prev.usage.costSource },
                createdBy: call.actor,
                createdAt: now,
                updatedAt: now,
                startedAt: now,
                endedAt: null,
              });
              bus.emit({ type: 'run.created', actor: call.actor, payload: { run } });
              const s = repos.sessions.update(prev.sessionId, (x) => ({ ...x, activeRunId: run.id, updatedAt: now, lastActivityAt: now }));
              bus.emit({ type: 'session.updated', actor: call.actor, payload: { session: s, changes: ['activeRunId'] } });
              return { runId: run.id };
            }),
        }),
      );
      reg(
        defineMethod('task.list', {
          handler: (p) =>
            repos.tasks.page({
              where: { project_id: p.projectId, assignee_session_id: p.assigneeSessionId, parent_task_id: p.parentTaskId, ...(p.status ? { status: p.status } : {}) },
              orderBy: 'created_at',
              direction: 'desc',
              limit: p.limit,
              cursor: p.cursor,
            }),
        }),
      );
      reg(
        defineMethod('integration.list', {
          handler: (p) =>
            repos.integrations.page({
              where: { project_id: p.projectId, ...(p.status ? { status: p.status } : {}) },
              orderBy: 'created_at',
              direction: 'desc',
              limit: p.limit,
              cursor: p.cursor,
            }),
        }),
      );
      reg(defineMethod('integration.get', { handler: (p) => repos.integrations.require(p.integrationId) }));
      const decideIntegration = (id: string, status: 'applied' | 'rejected', actor: Actor) =>
        ctx.db.transaction(() => {
          const i = repos.integrations.update(id, (x) => ({ ...x, status, updatedAt: clock.iso() }));
          bus.emit({ type: 'integration.updated', actor, payload: { integration: i, changes: ['status'] } });
          return i;
        });
      reg(defineMethod('integration.approve', { handler: (p, call) => decideIntegration(p.integrationId, 'applied', call.actor) }));
      reg(defineMethod('integration.reject', { handler: (p, call) => decideIntegration(p.integrationId, 'rejected', call.actor) }));
      reg(
        defineMethod('workspace.list', {
          handler: (p) => ({ items: repos.workspaces.find({ where: { project_id: p.projectId, task_id: p.taskId } }) }),
        }),
      );
      reg(defineMethod('workspace.get', { handler: (p) => repos.workspaces.require(p.workspaceId) }));
      reg(
        defineMethod('workspace.diff', {
          handler: (p) => {
            const ws = repos.workspaces.require(p.workspaceId);
            const patch = ws.branch === 'acc/auth-improve' ? PATCH : '';
            return {
              workspaceId: ws.id,
              baseRef: ws.baseRef,
              patch,
              stats: patch ? { files: 3, additions: 44, deletions: 6 } : { files: 0, additions: 0, deletions: 0 },
              files: patch
                ? [
                    { path: 'src/auth/session.ts', status: 'modified' as const, additions: 24, deletions: 4 },
                    { path: 'src/auth/LoginPrompt.tsx', status: 'added' as const, additions: 14, deletions: 0 },
                    { path: 'src/auth/useSession.ts', status: 'modified' as const, additions: 6, deletions: 2 },
                  ]
                : [],
            };
          },
        }),
      );
      reg(
        defineMethod('artifact.list', {
          handler: (p) =>
            repos.artifacts.page({
              where: { project_id: p.projectId, session_id: p.sessionId, run_id: p.runId, task_id: p.taskId, kind: p.kind },
              orderBy: 'created_at',
              direction: 'desc',
              limit: p.limit,
              cursor: p.cursor,
            }),
        }),
      );
      reg(
        defineMethod('models.list', {
          handler: () => ({
            source: 'mock' as const,
            models: [
              { id: 'anthropic/claude-sonnet-4-5', label: 'Claude Sonnet 4.5', provider: 'Anthropic' },
              { id: 'anthropic/claude-opus-4-1', label: 'Claude Opus 4.1', provider: 'Anthropic' },
              { id: 'anthropic/claude-haiku-4-5', label: 'Claude Haiku 4.5', provider: 'Anthropic' },
              { id: 'openai/gpt-5-mini', label: 'GPT-5 mini', provider: 'OpenAI' },
              { id: 'mock/echo', label: 'Mock (デモ)', provider: 'Core Daemon' },
            ],
          }),
        }),
      );
      reg(
        defineMethod('grant.list', {
          handler: (p) => ({
            items: repos.grants
              .find({ where: { revoked_at: p.includeRevoked ? undefined : null } })
              .filter((g) => (p.sessionId ? g.subject.kind === 'session' && g.subject.sessionId === p.sessionId : true)),
          }),
        }),
      );
      reg(
        defineMethod('grant.create', {
          handler: (p, call) =>
            ctx.db.transaction(() => {
              const grant: CapabilityGrant = repos.grants.insert({
                id: ctx.ids.next('grant'),
                subject: p.subject,
                parentGrantId: p.parentGrantId ?? null,
                permissions: p.permissions,
                scope: p.scope,
                limits: p.limits,
                depth: 0,
                lifetime: p.lifetime,
                expiresAt: p.expiresAt ?? null,
                revokedAt: null,
                reason: p.reason ?? null,
                grantedBy: call.actor,
                createdAt: clock.iso(),
              });
              bus.emit({ type: 'grant.created', actor: call.actor, payload: { grant } });
              return grant;
            }),
        }),
      );
      reg(
        defineMethod('grant.revoke', {
          handler: (p, call) =>
            ctx.db.transaction(() => {
              const g = repos.grants.update(p.grantId, (x) => ({ ...x, revokedAt: clock.iso() }));
              bus.emit({ type: 'grant.revoked', actor: call.actor, payload: { grantId: g.id, reason: p.reason ?? null } });
              return g;
            }),
        }),
      );

      // session.send: user message -> a mock chat run that streams a markdown reply.
      const streamReply = (session: Session, run: Run, text: string, onDone?: () => void, chunk = 6, everyMs = 45) => {
        const messageId = ctx.ids.next('message');
        let i = 0;
        let index = 0;
        const t = setInterval(() => {
          const piece = text.slice(i, i + chunk);
          i += chunk;
          if (piece) bus.publishDelta({ runId: run.id, sessionId: session.id, messageId, text: piece, index: index++ });
          if (i >= text.length) {
            clearInterval(t);
            ctx.db.transaction(() => {
              const now = clock.iso();
              const message = repos.messages.insert({
                id: messageId,
                sessionId: session.id,
                runId: run.id,
                role: 'assistant',
                content: [{ type: 'text', text }],
                author: { kind: 'agent', sessionId: session.id, runId: run.id },
                model: run.model,
                createdAt: now,
              });
              bus.emit({ type: 'message.created', actor: { kind: 'agent', sessionId: session.id, runId: run.id }, payload: { message } });
            });
            onDone?.();
          }
        }, everyMs);
        timers.push(t);
      };
      reg(
        defineMethod('session.send', {
          handler: (p, call) =>
            ctx.db.transaction(() => {
              const session = repos.sessions.require(p.sessionId);
              const now = clock.iso();
              const content: ContentPart[] = typeof p.content === 'string' ? [{ type: 'text', text: p.content }] : p.content;
              const message = repos.messages.insert({
                id: ctx.ids.next('message'),
                sessionId: session.id,
                runId: null,
                role: 'user',
                content,
                author: call.actor,
                model: null,
                createdAt: now,
              });
              bus.emit({ type: 'message.created', actor: call.actor, payload: { message } });
              const run = repos.runs.insert({
                id: ctx.ids.next('run'),
                sessionId: session.id,
                projectId: session.projectId,
                taskId: session.taskId,
                kind: 'chat',
                status: 'running',
                statusReason: null,
                model: p.model ?? session.model ?? 'mock/echo',
                runtime: null,
                workspaceId: null,
                parentRunId: null,
                retryOfRunId: null,
                attempt: 1,
                budgetId: null,
                triggerMessageId: message.id,
                usage: { inputTokens: 0, outputTokens: 0, costUsd: 0, costSource: 'unknown' },
                error: null,
                createdBy: call.actor,
                createdAt: now,
                updatedAt: now,
                startedAt: now,
                endedAt: null,
              });
              bus.emit({ type: 'run.created', actor: call.actor, payload: { run } });
              const s = repos.sessions.update(session.id, (x) => ({ ...x, activeRunId: run.id, lastActivityAt: now, updatedAt: now }));
              bus.emit({ type: 'session.updated', actor: call.actor, payload: { session: s, changes: ['activeRunId'] } });
              setTimeout(() => {
                streamReply(s, run, CHAT_REPLY, () => {
                  if (repos.runs.get(run.id)?.status !== 'running') return;
                  ctx.db.transaction(() => {
                    const done = repos.runs.update(run.id, (r) => ({
                      ...r,
                      status: 'completed',
                      endedAt: clock.iso(),
                      updatedAt: clock.iso(),
                      usage: { inputTokens: 820, outputTokens: 410, costUsd: 0, costSource: 'unknown' },
                    }));
                    bus.emit({ type: 'run.completed', actor: SYSTEM, payload: { run: done } });
                    repos.sessions.update(session.id, (x) => ({ ...x, activeRunId: null }));
                  });
                });
              }, 350);
              return { messageId: message.id, runId: run.id };
            }),
        }),
      );

      // ---------------------------------------------------------------- the scene
      return {
        start() {
          if (repos.projects.count() > 0) return; // reused ACC_HOME: keep existing data
          // Seed events are collected and emitted in timestamp order at the end, so the
          // event log reads chronologically like a real session would.
          const pendingEvents: { at: number; order: number; input: Parameters<typeof bus.emit>[0] }[] = [];
          const emit = (input: Parameters<typeof bus.emit>[0]) => {
            pendingEvents.push({ at: clock.now(), order: pendingEvents.length, input });
          };
          const T = Date.now();
          const at = (msAgo: number) => {
            clock.at(T - msAgo);
            return iso(T - msAgo);
          };
          const tx = <R>(fn: () => R) => ctx.db.transaction(fn);

          // project
          at(3 * 24 * 60 * MIN);
          const project: Project = tx(() => {
            const p = repos.projects.insert({
              id: ctx.ids.next('project'),
              name: 'AI-Agent-Command-Center',
              description: 'LLM agents command center',
              repoPath: null,
              defaultBranch: 'main',
              defaultModel: 'anthropic/claude-sonnet-4-5',
              createdAt: clock.iso(),
              updatedAt: clock.iso(),
              archivedAt: null,
            });
            emit({ type: 'project.created', actor: HUMAN, payload: { project: p } });
            return p;
          });

          const mkSession = (
            msAgo: number,
            s: Partial<Session> & { title: string; kind: Session['kind'] },
            actor: Actor = HUMAN,
          ): Session =>
            tx(() => {
              const now = at(msAgo);
              const session = repos.sessions.insert({
                id: ctx.ids.next('session'),
                projectId: project.id,
                model: 'anthropic/claude-sonnet-4-5',
                runtime: s.kind === 'agent' ? 'claude-agent-sdk' : null,
                systemPrompt: null,
                workspaceId: null,
                taskId: null,
                parentSessionId: null,
                activeRunId: null,
                pinned: false,
                createdBy: actor,
                createdAt: now,
                updatedAt: now,
                lastActivityAt: now,
                archivedAt: null,
                ...s,
              });
              emit({ type: 'session.created', actor, payload: { session } });
              return session;
            });

          const mkRun = (
            session: Session,
            msAgo: number,
            r: Partial<Run> & { status: RunStatus },
            actor: Actor = HUMAN,
          ): Run =>
            tx(() => {
              const now = at(msAgo);
              const run = repos.runs.insert({
                id: ctx.ids.next('run'),
                sessionId: session.id,
                projectId: session.projectId,
                taskId: session.taskId,
                kind: session.kind === 'agent' ? 'agent' : 'chat',
                statusReason: null,
                model: session.model,
                runtime: session.runtime,
                workspaceId: session.workspaceId,
                parentRunId: null,
                retryOfRunId: null,
                attempt: 1,
                budgetId: null,
                triggerMessageId: null,
                usage: { inputTokens: 0, outputTokens: 0, costUsd: 0, costSource: 'reported' },
                error: null,
                createdBy: actor,
                createdAt: now,
                updatedAt: now,
                startedAt: now,
                endedAt: null,
                ...r,
              });
              emit({ type: 'run.created', actor, payload: { run } });
              if (r.status !== 'queued') {
                emit({ type: 'run.status_changed', actor: SYSTEM, payload: { runId: run.id, from: 'queued', to: 'running', reason: null }, refs: { sessionId: session.id, projectId: session.projectId, taskId: session.taskId } });
              }
              const live = !['completed', 'failed', 'cancelled', 'interrupted'].includes(run.status);
              repos.sessions.update(session.id, (s) => ({
                ...s,
                activeRunId: live ? run.id : s.activeRunId,
                lastActivityAt: run.endedAt ?? now,
              }));
              return run;
            });

          const msg = (session: Session, run: Run | null, msAgo: number, role: Message['role'], content: ContentPart[], author?: Actor) =>
            tx(() => {
              const now = at(msAgo);
              const a: Actor = author ?? (role === 'user' ? HUMAN : run ? { kind: 'agent', sessionId: session.id, runId: run.id } : SYSTEM);
              const m = repos.messages.insert({ id: ctx.ids.next('message'), sessionId: session.id, runId: run?.id ?? null, role, content, author: a, model: role === 'assistant' ? session.model : null, createdAt: now });
              emit({ type: 'message.created', actor: a, payload: { message: m } });
              if (run && role === 'assistant') {
                for (const p of content) {
                  if (p.type === 'tool_call') emit({ type: 'tool.called', actor: a, payload: { runId: run.id, toolCallId: p.toolCallId, name: p.name, input: p.input } });
                }
              }
              return m;
            });

          const mkTask = (msAgo: number, title: string, status: Task['status'], by: AgentActor, extra: Partial<Task> = {}): Task =>
            tx(() => {
              const now = at(msAgo);
              const t = repos.tasks.insert({
                id: ctx.ids.next('task'),
                projectId: project.id,
                parentTaskId: null,
                title,
                description: '',
                acceptanceCriteria: [],
                status,
                priority: 'normal',
                dependsOn: [],
                assigneeSessionId: null,
                workspaceId: null,
                resultSummary: null,
                createdBy: by,
                createdAt: now,
                updatedAt: now,
                completedAt: status === 'done' ? now : null,
                ...extra,
              });
              emit({ type: 'task.created', actor: by, payload: { task: t } });
              return t;
            });

          const decision = (msAgo: number, by: AgentActor, d: string, why: string) =>
            tx(() => {
              at(msAgo);
              emit({ type: 'orchestrator.decision', actor: by, payload: { decision: d, rationale: why }, refs: { sessionId: by.sessionId, runId: by.runId, projectId: project.id } });
            });

          // --- yesterday: a finished chat with rich markdown
          const report = mkSession(26 * 60 * MIN, { kind: 'chat', title: '週次レポートの下書き' });
          const reportRun = mkRun(report, 26 * 60 * MIN - 5000, { kind: 'chat', status: 'completed', endedAt: iso(T - 26 * 60 * MIN + 20_000), usage: { inputTokens: 2400, outputTokens: 900, costUsd: 0.06, costSource: 'reported' } });
          msg(report, null, 26 * 60 * MIN, 'user', [{ type: 'text', text: '今週の進捗をレポートにまとめて。描画性能の改善がメイン' }]);
          msg(report, reportRun, 26 * 60 * MIN - 20_000, 'assistant', [{ type: 'text', text: CHAT_REPLY }]);

          mkSession(5 * 60 * MIN, { kind: 'chat', title: 'レビュー観点の整理' });

          // --- orchestrator
          const orch = mkSession(32 * MIN, { kind: 'chat', title: '設計チャット', model: 'anthropic/claude-opus-4-1' });
          const orchRun = mkRun(orch, 31 * MIN, { kind: 'orchestrator', status: 'running', model: 'anthropic/claude-opus-4-1', usage: { inputTokens: 48_000, outputTokens: 6_100, costUsd: 1.1, costSource: 'reported' } });
          const orchActor: AgentActor = { kind: 'agent', sessionId: orch.id, runId: orchRun.id };
          msg(orch, null, 31.5 * MIN, 'user', [{ type: 'text', text: '未対応の Issue を片付けたい。独立して進められるものは並列にして、最後にまとめて統合して' }]);
          msg(orch, orchRun, 31 * MIN, 'assistant', [
            { type: 'text', text: 'Issue を確認し、独立して進められる 5 つの Task に分けます。' },
            { type: 'tool_call', toolCallId: 'o1', name: 'task.create', input: { title: '認証機能の改善' } },
            { type: 'tool_call', toolCallId: 'o2', name: 'task.create', input: { title: 'テストの拡充' } },
            { type: 'tool_call', toolCallId: 'o3', name: 'task.create', input: { title: 'API のリファクタリング' } },
          ]);
          decision(30.8 * MIN, orchActor, 'Task を 5 つに分割', '認証と API は独立して進められるため並列にします');

          const tAuth = mkTask(30.5 * MIN, '認証機能の改善', 'running', orchActor);
          const tTests = mkTask(30.4 * MIN, 'テストの拡充', 'running', orchActor);
          const tApi = mkTask(30.3 * MIN, 'API のリファクタリング', 'running', orchActor);
          const tReadme = mkTask(30.2 * MIN, 'README の整備', 'done', orchActor, { resultSummary: 'セットアップ手順と構成図を追加しました' });
          const tFront = mkTask(30.1 * MIN, 'フロントエンドの修正', 'failed', orchActor);

          const ws = (msAgo: number, branch: string, taskId: string): Workspace =>
            tx(() => {
              const now = at(msAgo);
              const w = repos.workspaces.insert({ id: ctx.ids.next('workspace'), projectId: project.id, kind: 'worktree', status: 'ready', path: join(tmpdir(), 'acc-playground-worktrees', branch.replace(/\//g, '-')), branch, baseRef: 'main', taskId, lockedByRunId: null, error: null, createdAt: now, updatedAt: now });
              emit({ type: 'workspace.created', actor: orchActor, payload: { workspace: w } });
              return w;
            });

          // README (completed long ago)
          const wReadme = ws(30 * MIN, 'acc/readme', tReadme.id);
          const readme = mkSession(30 * MIN, { kind: 'agent', title: 'README の整備', parentSessionId: orch.id, taskId: tReadme.id, workspaceId: wReadme.id, model: 'anthropic/claude-haiku-4-5' }, orchActor);
          mkRun(readme, 29.5 * MIN, { status: 'completed', endedAt: iso(T - 18 * MIN), usage: { inputTokens: 9000, outputTokens: 2100, costUsd: 0.21, costSource: 'reported' } }, orchActor);

          // Auth worker: running, rich transcript
          const wAuth = ws(12.5 * MIN, 'acc/auth-improve', tAuth.id);
          const auth = mkSession(12.3 * MIN, { kind: 'agent', title: '認証機能の改善', parentSessionId: orch.id, taskId: tAuth.id, workspaceId: wAuth.id }, orchActor);
          const authRun = mkRun(auth, 12.07 * MIN, { status: 'running', usage: { inputTokens: 21_000, outputTokens: 3_300, costUsd: 0.42, costSource: 'reported' } }, orchActor);
          msg(auth, null, 12.05 * MIN, 'user', [{ type: 'text', text: 'セッションの有効期限切れ時に、ユーザーに再ログインを促して。既存の API 呼び出しは壊さないこと。' }], orchActor);
          msg(auth, authRun, 11.8 * MIN, 'assistant', [
            { type: 'text', text: 'まず現在の期限切れ処理を確認します。' },
            { type: 'tool_call', toolCallId: 'a1', name: 'Read', input: { file_path: 'C:/repo/src/auth/session.ts' } },
            { type: 'tool_call', toolCallId: 'a2', name: 'Read', input: { file_path: 'C:/repo/src/auth/useSession.ts' } },
            { type: 'tool_call', toolCallId: 'a3', name: 'Grep', input: { pattern: 'expiresAt' } },
            { type: 'tool_call', toolCallId: 'a4', name: 'Read', input: { file_path: 'C:/repo/src/api/client.ts' } },
            { type: 'tool_call', toolCallId: 'a5', name: 'Grep', input: { pattern: 'refresh(' } },
            { type: 'tool_call', toolCallId: 'a6', name: 'Read', input: { file_path: 'C:/repo/src/auth/__tests__/session.test.ts' } },
          ]);
          msg(auth, authRun, 11.6 * MIN, 'tool', ['a1', 'a2', 'a3', 'a4', 'a5', 'a6'].map((id) => ({ type: 'tool_result' as const, toolCallId: id, output: 'ok', isError: false })));
          msg(auth, authRun, 9 * MIN, 'assistant', [
            { type: 'text', text: '`isExpired()` は API 呼び出しの直前にしか評価されていないため、期限切れ後に最初のリクエストが失敗してから気づく作りになっています。猶予時間を持たせて事前に促します。' },
            { type: 'tool_call', toolCallId: 'a7', name: 'Edit', input: { file_path: 'C:/repo/src/auth/session.ts', old_string: 'a\nb\nc\nd\ne\nf', new_string: Array.from({ length: 24 }, (_, i) => `l${i}`).join('\n') } },
          ]);
          msg(auth, authRun, 8.9 * MIN, 'tool', [{ type: 'tool_result', toolCallId: 'a7', output: 'Edited src/auth/session.ts', isError: false }]);
          tx(() => {
            const created = at(8 * MIN);
            const a: Approval = repos.approvals.insert({ id: ctx.ids.next('approval'), kind: 'tool_use', status: 'approved', title: 'コマンドの実行', detail: 'pnpm test src/auth', payload: { toolName: 'Bash', input: { command: 'pnpm test src/auth' } }, projectId: project.id, sessionId: auth.id, runId: authRun.id, taskId: tAuth.id, integrationId: null, requestedBy: { kind: 'agent', sessionId: auth.id, runId: authRun.id }, resolvedBy: HUMAN, resolutionNote: null, createdAt: created, resolvedAt: iso(T - 7.8 * MIN) });
            emit({ type: 'approval.requested', actor: a.requestedBy, payload: { approval: { ...a, status: 'pending', resolvedAt: null, resolvedBy: null } } });
            at(7.8 * MIN);
            emit({ type: 'approval.resolved', actor: HUMAN, payload: { approval: a } });
          });
          tx(() => {
            at(6 * MIN);
            const art: Artifact = repos.artifacts.insert({ id: ctx.ids.next('artifact'), projectId: project.id, sessionId: auth.id, runId: authRun.id, taskId: tAuth.id, workspaceId: wAuth.id, title: 'pnpm test src/auth', createdBy: { kind: 'agent', sessionId: auth.id, runId: authRun.id }, createdAt: clock.iso(), kind: 'test_result', data: { command: 'pnpm test src/auth', passed: true, exitCode: 0, durationMs: 4210, summary: '24 件成功 · 0 件失敗', output: ' ✓ src/auth/__tests__/session.test.ts (18)\n ✓ src/auth/__tests__/useSession.test.ts (6)\n\n Test Files  2 passed (2)\n      Tests  24 passed (24)' } });
            emit({ type: 'artifact.created', actor: art.createdBy, payload: { artifact: art } });
          });

          // Tests worker: running
          const wTests = ws(4 * MIN, 'acc/test-coverage', tTests.id);
          const tests = mkSession(3.95 * MIN, { kind: 'agent', title: 'テストの拡充', parentSessionId: orch.id, taskId: tTests.id, workspaceId: wTests.id, model: 'anthropic/claude-haiku-4-5' }, orchActor);
          const testsRun = mkRun(tests, 3.85 * MIN, { status: 'running', model: 'anthropic/claude-haiku-4-5', usage: { inputTokens: 6000, outputTokens: 800, costUsd: 0.08, costSource: 'estimated' } }, orchActor);

          // API worker: awaiting approval
          const wApi = ws(9 * MIN, 'acc/api-refactor', tApi.id);
          const api = mkSession(9 * MIN, { kind: 'agent', title: 'API のリファクタリング', parentSessionId: orch.id, taskId: tApi.id, workspaceId: wApi.id }, orchActor);
          const apiRun = mkRun(api, 8.8 * MIN, { status: 'awaiting_approval', usage: { inputTokens: 15_000, outputTokens: 2_000, costUsd: 0.31, costSource: 'reported' } }, orchActor);
          tx(() => {
            const now = at(2.2 * MIN);
            const a = repos.approvals.insert({ id: ctx.ids.next('approval'), kind: 'tool_use', status: 'pending', title: 'コマンドの実行', detail: 'pnpm db:migrate --env test', payload: { toolName: 'Bash', input: { command: 'pnpm db:migrate --env test' } }, projectId: project.id, sessionId: api.id, runId: apiRun.id, taskId: tApi.id, integrationId: null, requestedBy: { kind: 'agent', sessionId: api.id, runId: apiRun.id }, resolvedBy: null, resolutionNote: null, createdAt: now, resolvedAt: null });
            emit({ type: 'approval.requested', actor: a.requestedBy, payload: { approval: a } });
            emit({ type: 'run.status_changed', actor: SYSTEM, payload: { runId: apiRun.id, from: 'running', to: 'awaiting_approval', reason: null }, refs: { sessionId: api.id, projectId: project.id, taskId: tApi.id } });
          });

          // Frontend worker: failed
          const wFront = ws(10 * MIN, 'acc/frontend-fix', tFront.id);
          const front = mkSession(9.8 * MIN, { kind: 'agent', title: 'フロントエンドの修正', parentSessionId: orch.id, taskId: tFront.id, workspaceId: wFront.id }, orchActor);
          const frontRun = mkRun(front, 9.7 * MIN, { status: 'failed', endedAt: iso(T - 1.05 * MIN), error: { code: 'tests_failed', message: 'テストが 3 件失敗しました: LoginForm.test.tsx\n  ✕ submits credentials on Enter (12 ms)\n  ✕ shows a validation error for empty password (4 ms)' }, usage: { inputTokens: 25_000, outputTokens: 3_000, costUsd: 0.52, costSource: 'reported' } }, orchActor);
          tx(() => {
            at(1.05 * MIN);
            emit({ type: 'run.failed', actor: SYSTEM, payload: { run: repos.runs.require(frontRun.id), error: frontRun.error! } });
          });
          decision(0.9 * MIN, orchActor, 'フロントエンドの修正は人間の判断を待つ', 'テスト失敗の原因が仕様の曖昧さにあるため、自動で再試行しません');

          // queued
          const deps = mkSession(1.5 * MIN, { kind: 'agent', title: '依存関係の更新', parentSessionId: orch.id }, orchActor);
          mkRun(deps, 1.4 * MIN, { status: 'queued', startedAt: null }, orchActor);

          // integration awaiting review
          tx(() => {
            const now = at(3 * MIN);
            const i: Integration = repos.integrations.insert({
              id: ctx.ids.next('integration'),
              projectId: project.id,
              title: '統合候補 #2（2 Task）',
              status: 'awaiting_approval',
              taskIds: [tReadme.id, tAuth.id],
              branch: 'acc/integration/2',
              targetRef: 'main',
              workspaceId: null,
              steps: [
                { index: 0, kind: 'merge', status: 'succeeded', title: 'README の整備 をマージ', taskId: tReadme.id, artifactId: null, detail: null, startedAt: now, endedAt: now },
                { index: 1, kind: 'merge', status: 'succeeded', title: '認証機能の改善 をマージ', taskId: tAuth.id, artifactId: null, detail: null, startedAt: now, endedAt: now },
                { index: 2, kind: 'verify', status: 'succeeded', title: 'ビルド成功 · テスト 128/128 成功', taskId: null, artifactId: null, detail: null, startedAt: now, endedAt: now },
              ],
              approvalId: null,
              error: null,
              createdBy: orchActor,
              createdAt: now,
              updatedAt: now,
            });
            emit({ type: 'integration.created', actor: orchActor, payload: { integration: i } });
          });

          pendingEvents.sort((x, y) => x.at - y.at || x.order - y.order);
          ctx.db.transaction(() => {
            for (const e of pendingEvents) {
              clock.at(e.at);
              bus.emit(e.input);
            }
          });
          clock.at(null);

          if (!live) return;
          // ---------------------------------------------------------------- live simulation
          const testTools = [
            { name: 'Bash', input: { command: 'pnpm test auth' } },
            { name: 'Read', input: { file_path: 'C:/repo/src/auth/__tests__/expiry.test.ts' } },
            { name: 'Grep', input: { pattern: 'needsReauth' } },
            { name: 'Edit', input: { file_path: 'C:/repo/src/auth/__tests__/expiry.test.ts', old_string: 'a', new_string: 'a\nb\nc' } },
          ];
          let k = 0;
          timers.push(
            setInterval(() => {
              const run = repos.runs.get(testsRun.id);
              if (run?.status !== 'running') return;
              const t = testTools[k++ % testTools.length]!;
              bus.emit({ type: 'tool.called', actor: { kind: 'agent', sessionId: tests.id, runId: testsRun.id }, payload: { runId: testsRun.id, toolCallId: `lt${k}`, name: t.name, input: t.input }, refs: { sessionId: tests.id, projectId: project.id } });
            }, 2600),
          );
          timers.push(
            setInterval(() => {
              const run = repos.runs.get(orchRun.id);
              if (run?.status !== 'running') return;
              bus.emit({ type: 'tool.called', actor: orchActor, payload: { runId: orchRun.id, toolCallId: `ow${Date.now()}`, name: 'task.wait', input: { taskIds: [tAuth.id, tTests.id, tApi.id] } }, refs: { sessionId: orch.id, projectId: project.id } });
            }, 9000),
          );
          // The auth worker keeps writing its reply (streaming deltas), then starts over.
          const loop = () => {
            const run = repos.runs.get(authRun.id);
            if (run?.status !== 'running') return;
            // Slow on purpose (about a minute per reply) so the caret is usually visible.
            streamReply(
              repos.sessions.require(auth.id),
              run,
              AUTH_REPLY,
              () => {
                const t = setTimeout(loop, 90_000);
                timers.push(t);
              },
              2,
              140,
            );
          };
          setTimeout(loop, 1500);
        },
        stop() {
          for (const t of timers) clearInterval(t);
        },
      };
    },
  });
}

async function main() {
  const home = process.env.ACC_HOME || mkdtempSync(join(tmpdir(), 'acc-playground-'));
  const port = Number(process.env.ACC_PORT || 47899);
  const live = process.env.PLAYGROUND_LIVE !== '0';
  const clock = createSeedClock();
  const log = createLogger(parseLogLevel(process.env.ACC_LOG_LEVEL, 'warn'));
  const daemon = await startDaemon({
    home,
    port,
    clock,
    log,
    env: { ...process.env, ACC_HOME: home },
    modules: [...defaultModules, playgroundModule(clock, live)],
  });
  console.log(`[playground] Core Daemon on ${daemon.url} (ACC_HOME=${home})`);
  console.log('[playground] start the UI with the same ACC_HOME:  pnpm --filter @acc/desktop dev');
  const stop = () => {
    void daemon.close().then(() => process.exit(0));
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

void main();
