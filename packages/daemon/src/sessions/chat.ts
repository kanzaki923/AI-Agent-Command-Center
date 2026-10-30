import type { Message, Run, Session } from '@acc/protocol';
import type { RunExecutor } from '../contracts';
import type { DaemonContext } from '../core/context';
import { rememberPastRuns } from '../assistant/history';
import { MOCK_RIGHT_HAND_MODEL } from '../assistant/permissions';
import { invalidParams } from '../core/errors';
import { apiTools, runToolLoop, toChatMessages } from '../llm';

/** Model used when nothing is configured and LiteLLM is not set up (works offline). */
export const OFFLINE_FALLBACK_MODEL = 'mock/echo';

/** Most recent messages sent to the model per chat run. */
export const CHAT_HISTORY_LIMIT = 200;

/**
 * Model for a new chat run: explicit override > session model > settings default >
 * the offline mock when LiteLLM is not configured (null = nothing usable). The assistant
 * (assistant/) reads `settings.assistant.model` before the default and falls back to its own
 * mock.
 */
export function resolveChatModel(
  ctx: DaemonContext,
  session: Pick<Session, 'id' | 'model'>,
  override?: string | null,
): string | null {
  const s = ctx.settings.get();
  const assistant = ctx.hasService('assistant') && ctx.service('assistant').isAssistant(session.id);
  return (
    override ??
    session.model ??
    (assistant ? s.assistant.model : null) ??
    s.defaultModel ??
    (s.litellm.baseUrl ? null : assistant ? MOCK_RIGHT_HAND_MODEL : OFFLINE_FALLBACK_MODEL)
  );
}

/** Ids of the run being retried and its predecessors (their partial output is not history). */
function retryChain(ctx: DaemonContext, run: Run): Set<string> {
  const ids = new Set<string>();
  let cur = run.retryOfRunId;
  while (cur && !ids.has(cur)) {
    ids.add(cur);
    cur = ctx.repos.runs.get(cur)?.retryOfRunId ?? null;
  }
  return ids;
}

/**
 * Executor for `chat` runs: streams the assistant reply for the session history through the
 * LLM gateway and persists it. If the session holds capability grants, the methods they
 * allow are offered as tools (a plain chat becomes an operator of the app); without grants
 * the tool list is empty and this is ordinary chat. A message sent while it answers is
 * taken in right after (the run continues), and the daemon's per-run limits apply.
 */
export function createChatExecutor(ctx: DaemonContext): RunExecutor {
  return async (ctl) => {
    const run = ctl.run;
    const session = ctx.repos.sessions.require(run.sessionId);
    // The assistant (assistant/): its own model order, a daily limit on its own calls, and a
    // system prompt that carries the status of every tree.
    const assistant =
      ctx.hasService('assistant') && ctx.service('assistant').isAssistant(session.id)
        ? ctx.service('assistant')
        : null;
    assistant?.assertWithinDailyLimit();
    const model = requireChatModel(ctx, run, session);
    // Messages that waited for this run are in its history; later ones are injected at the
    // next step (spec 20261029 §3.2, D9).
    const inbox = ctx.hasService('supervisorInbox') ? ctx.service('supervisorInbox') : null;
    inbox?.drain(run.id);
    const history = chatHistory(ctx, run, session);
    // The assistant remembers past runs by what was said (assistant/history.ts) and gets
    // its fixed prompt and the changing status as two system messages.
    const messages = assistant
      ? [
          ...assistant
            .systemPrompts(session, history)
            .map((content) => ({ role: 'system' as const, content })),
          // Notices (meta.wake) go as user turns, as a supervisor's wakes do.
          ...toChatMessages(
            rememberPastRuns(history, run.id).map((m) =>
              m.meta?.kind === 'wake' ? ({ ...m, role: 'user' } satisfies Message) : m,
            ),
          ),
        ]
      : toChatMessages(history, { systemPrompt: session.systemPrompt });
    await runToolLoop({
      ctx,
      ctl,
      model,
      messages,
      tools: apiTools(ctx, ctl.actor),
      maxTurns: ctx.settings.get().supervisor.maxModelCallsPerRun,
      failOnTurnLimit: true,
      ...(inbox ? { inject: () => inbox.injectedMessages(run.id) } : {}),
    });
  };
}

/** The run's model, or a user-facing error when nothing is configured. */
export function requireChatModel(ctx: DaemonContext, run: Run, session: Session): string {
  const model = run.model ?? resolveChatModel(ctx, session);
  if (!model) {
    throw invalidParams(
      'モデルが設定されていません。セッションか設定で既定のモデルを指定してください',
    );
  }
  return model;
}

/** Latest messages of the session for a run, without partial output of retried attempts. */
export function chatHistory(ctx: DaemonContext, run: Run, session: Session): Message[] {
  const skip = retryChain(ctx, run);
  return ctx.repos.messages
    .find({
      where: { session_id: session.id },
      orderBy: 'id',
      direction: 'desc',
      limit: CHAT_HISTORY_LIMIT,
    })
    .reverse()
    .filter((m) => !m.runId || !skip.has(m.runId));
}
