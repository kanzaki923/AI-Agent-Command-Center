import { defineModule } from '../module';
import { createChatExecutor } from './chat';
import { sessionArchive } from './methods/archive';
import { sessionCreate } from './methods/create';
import { sessionDelegate, sessionUndelegate } from './methods/delegate';
import { sessionGet } from './methods/get';
import { sessionList } from './methods/list';
import { sessionMessages } from './methods/messages';
import { sessionResume } from './methods/resume';
import { sessionSearch } from './methods/search';
import { sessionSend } from './methods/send';
import { sessionSetBudget } from './methods/setBudget';
import { sessionSpawn } from './methods/spawn';
import { sessionStop } from './methods/stop';
import { sessionTree } from './methods/tree';
import { sessionUpdate } from './methods/update';
import { sessionsMigrations } from './search';
import { SessionService } from './service';
import { Spawner } from './spawn';

export { SessionService } from './service';
export {
  createChatExecutor,
  chatHistory,
  requireChatModel,
  resolveChatModel,
  OFFLINE_FALLBACK_MODEL,
} from './chat';
export type { CreateSessionInput } from './service';
export { searchMessages, makeSnippet } from './search';
export { sessionBudgetId, sessionScope } from './methods/shared';
export { Spawner, SPAWNER_SYSTEM, briefContent, spawnProjectId } from './spawn';

/**
 * Sessions and messages. One file per method under `methods/` (each track owns its own
 * files; spec 20261029 §5): create / list / get / update / archive / messages / send /
 * search, and the session-tree methods spawn / stop / resume / delegate / undelegate /
 * setBudget / tree.
 *
 * `session.send` appends the user message and starts a run through `runs` (kind `chat`
 * for chat sessions, `agent` for agent sessions). This module registers the `chat`
 * executor (sessions/chat.ts); the `agent` executor belongs to the runtime module.
 * Services: `sessions` (SessionService), `spawner` (sessions/spawn.ts).
 */
export const sessionsModule = defineModule({
  name: 'sessions',
  migrations: sessionsMigrations,
  register(ctx) {
    ctx.provide('sessions', new SessionService(ctx));
    const spawner = new Spawner(ctx);
    ctx.provide('spawner', spawner);

    ctx.methods.register(
      sessionCreate(ctx),
      sessionList(ctx),
      sessionGet(ctx),
      sessionUpdate(ctx),
      sessionArchive(ctx),
      sessionMessages(ctx),
      sessionSend(ctx),
      sessionSearch(ctx),
      sessionSpawn(ctx),
      sessionStop(ctx),
      sessionResume(ctx),
      sessionDelegate(ctx),
      sessionUndelegate(ctx),
      sessionSetBudget(ctx),
      sessionTree(ctx),
    );

    return {
      start() {
        // Executors are registered once every module provided its services.
        if (ctx.hasService('runs'))
          ctx.service('runs').registerExecutor('chat', createChatExecutor(ctx));
        // Children waiting for siblings or a free slot start by themselves (spawn.ts).
        ctx.onClose(spawner.start());
      },
    };
  },
});
