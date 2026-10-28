import type { Message, Run } from '@acc/protocol';
import type { RunExecutor } from '../contracts';
import type { DaemonContext } from '../core/context';
import { invalidParams } from '../core/errors';
import { apiTools, runToolLoop, toChatMessages } from '../llm';

/** Model used when nothing is configured and LiteLLM is not set up (works offline). */
export const OFFLINE_FALLBACK_MODEL = 'mock/echo';

/** Most recent messages sent to the model per chat run. */
export const CHAT_HISTORY_LIMIT = 200;

/**
 * Model for a new chat run: explicit override > session model > settings default >
 * the offline mock when LiteLLM is not configured (null = nothing usable).
 */
export function resolveChatModel(
  ctx: DaemonContext,
  sessionModel: string | null,
  override?: string | null,
): string | null {
  const s = ctx.settings.get();
  return (
    override ??
    sessionModel ??
    s.defaultModel ??
    (s.litellm.baseUrl ? null : OFFLINE_FALLBACK_MODEL)
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
 * the tool list is empty and this is ordinary chat.
 */
export function createChatExecutor(ctx: DaemonContext): RunExecutor {
  return async (ctl) => {
    const run = ctl.run;
    const session = ctx.repos.sessions.require(run.sessionId);
    const model = run.model ?? resolveChatModel(ctx, session.model);
    if (!model) {
      throw invalidParams(
        'モデルが設定されていません。セッションか設定で既定のモデルを指定してください',
      );
    }
    const skip = retryChain(ctx, run);
    const history: Message[] = ctx.repos.messages
      .find({
        where: { session_id: session.id },
        orderBy: 'id',
        direction: 'desc',
        limit: CHAT_HISTORY_LIMIT,
      })
      .reverse()
      .filter((m) => !m.runId || !skip.has(m.runId));
    await runToolLoop({
      ctx,
      ctl,
      model,
      messages: toChatMessages(history, { systemPrompt: session.systemPrompt }),
      tools: apiTools(ctx, ctl.actor),
    });
  };
}
