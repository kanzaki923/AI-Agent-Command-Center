import type { Message, Run, Session } from '@acc/protocol';
import type { RunExecutor } from '../contracts';
import type { DaemonContext } from '../core/context';
import { rememberPastRuns } from '../assistant/history';
import { MOCK_RIGHT_HAND_MODEL } from '../assistant/permissions';
import { isLlmConfigured } from '../core/config';
import { invalidParams } from '../core/errors';
import { conversationFrame, framedUserText } from './framing';
import { apiTools, runToolLoop, toChatMessages, windowLength } from '../llm';

/** Model used when nothing is configured and LiteLLM is not set up (works offline). */
export const OFFLINE_FALLBACK_MODEL = 'mock/echo';

/** Most recent messages sent to the model per chat run. */
export const CHAT_HISTORY_LIMIT = 200;

/**
 * Model named for a new chat run: explicit override > session model > settings default (the
 * roster's last row) > the offline mock when no provider is configured. Null = nothing chosen
 * yet: the first run picks and saves a roster (chooseChatModel). The assistant (assistant/)
 * reads `settings.assistant.model` before the default and falls back to its own mock.
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
    (isLlmConfigured(s) ? null : assistant ? MOCK_RIGHT_HAND_MODEL : OFFLINE_FALLBACK_MODEL)
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
    const model = await chooseChatModel(ctx, run, session);
    // Messages that waited for this run are in its history; later ones are injected at the
    // next step (spec 20261029 §3.2, D9).
    const inbox = ctx.hasService('supervisorInbox') ? ctx.service('supervisorInbox') : null;
    inbox?.drain(run.id);
    const history = chatHistory(ctx, run, session);
    const tools = apiTools(ctx, ctl.actor);
    // The assistant remembers past runs by what was said (assistant/history.ts). Its fixed
    // prompt comes first and the status of this run last, after the history: the fixed
    // prompt and the history stay one unchanged prefix a prompt cache can hold.
    const prompts = assistant?.systemPrompts(session, history);
    const messages = assistant
      ? [
          { role: 'system' as const, content: prompts![0] },
          // Notices (meta.wake) go as user turns, as a supervisor's wakes do.
          ...toChatMessages(
            rememberPastRuns(history, run.id).map((m) =>
              m.meta?.kind === 'wake' ? ({ ...m, role: 'user' } satisfies Message) : m,
            ),
            { userText: framedUserText(ctx, session, { briefQuoted: false }) },
          ),
          { role: 'system' as const, content: prompts![1] },
        ]
      : toChatMessages(history, {
          // The daemon's frame; a parent's request is quoted in it, never taken as the frame.
          systemPrompt: conversationFrame(ctx, session, { kind: 'chat', tools: tools.length }),
          userText: framedUserText(ctx, session, { briefQuoted: true }),
        });
    await runToolLoop({
      ctx,
      ctl,
      model,
      messages,
      tools,
      maxTurns: ctx.settings.get().supervisor.maxModelCallsPerRun,
      failOnTurnLimit: true,
      ...(inbox ? { inject: () => inbox.injectedMessages(run.id) } : {}),
    });
  };
}

/**
 * The run's model. With nothing chosen yet (a provider is connected but the roster is empty),
 * a first roster is picked from the providers and saved to the settings (snapshot
 * 20261030_model-roster-spec.md): from then on it is fixed and only the person changes it, so
 * nobody has to choose a model before the first message and nothing changes behind their back.
 * The run records the model (run.updated `["model"]`).
 */
export async function chooseChatModel(
  ctx: DaemonContext,
  run: Run,
  session: Session,
): Promise<string> {
  const named = run.model ?? resolveChatModel(ctx, session);
  if (named) return named;
  const roster = await ctx.service('llm').suggestRoster();
  // Another run may have saved one meanwhile.
  const model = resolveChatModel(ctx, session) ?? roster?.defaultModel ?? null;
  if (!model) {
    throw invalidParams(
      '接続先から使えるモデルを見つけられませんでした。設定の「接続」を確認してください',
    );
  }
  const s = ctx.settings.get();
  if (!s.defaultModel && roster) {
    const changes = ctx.settings.update({
      defaultModel: roster.defaultModel,
      ...(s.modelRules.length === 0 ? { modelRules: roster.rules } : {}),
    });
    ctx.bus.emit({
      type: 'settings.updated',
      actor: { kind: 'system', component: 'llm' },
      payload: { changes },
    });
  }
  const next = ctx.repos.runs.update(run.id, (r) => ({ ...r, model, updatedAt: ctx.clock.iso() }));
  ctx.bus.emit({
    type: 'run.updated',
    actor: { kind: 'system', component: 'llm' },
    payload: { run: next, changes: ['model'] },
  });
  return model;
}

/**
 * Latest messages of the session for a run (at most CHAT_HISTORY_LIMIT, cut in steps:
 * windowLength), without partial output of retried attempts.
 */
export function chatHistory(ctx: DaemonContext, run: Run, session: Session): Message[] {
  const skip = retryChain(ctx, run);
  const total = ctx.repos.messages.count({ where: { session_id: session.id } });
  const window = ctx.repos.messages
    .find({
      where: { session_id: session.id },
      orderBy: 'id',
      direction: 'desc',
      // Cut in steps (windowLength), so the history stays a prefix the prompt cache can hold.
      limit: windowLength(total, CHAT_HISTORY_LIMIT),
    })
    .reverse()
    // A message still queued was not handed to this run (it waits for a run of its own, e.g.
    // a request with its own work place to the assistant): not part of what it answers.
    .filter((m) => (!m.runId || !skip.has(m.runId)) && m.delivery !== 'queued');
  return inHandOverOrder(ctx, session.id, window);
}

/** The time-ordered part of an id (ids of every kind share one monotonic generator). */
const idTime = (id: string) => id.slice(id.indexOf('_') + 1);

/**
 * Messages in the order the conversation saw them. A message that waited for a later run
 * (sent while another run was answering) is stored before that run's last words but was
 * handed over after them: it goes where the run that took it (inbox `consumedByRunId`)
 * began. Messages taken at a step of a running run keep their place. Fixed once a message is
 * taken, so the history stays a prefix across runs.
 */
function inHandOverOrder(ctx: DaemonContext, sessionId: string, messages: Message[]): Message[] {
  if (messages.length === 0 || !ctx.hasService('supervisorInbox')) return messages;
  const takenBy = new Map<string, string>();
  for (const item of ctx.repos.inboxItems.find({
    where: { session_id: sessionId, status: 'consumed' },
    sql: { clause: 'created_at >= ?', params: [messages[0]!.createdAt] },
  })) {
    if (item.refs.messageId && item.consumedByRunId) {
      takenBy.set(item.refs.messageId, item.consumedByRunId);
    }
  }
  if (takenBy.size === 0) return messages;
  const at = (m: Message) => {
    const own = idTime(m.id);
    const run = m.runId ? undefined : takenBy.get(m.id);
    return run && idTime(run) > own ? idTime(run) : own;
  };
  return messages
    .map((m) => ({ m, at: at(m), own: idTime(m.id) }))
    .sort((a, b) =>
      a.at !== b.at ? (a.at < b.at ? -1 : 1) : a.own < b.own ? -1 : a.own > b.own ? 1 : 0,
    )
    .map((x) => x.m);
}
