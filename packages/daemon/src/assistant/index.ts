import { defineMethod } from '../api/registry';
import { defineModule } from '../module';
import { mockRightHand } from './mockRightHand';
import { MOCK_RIGHT_HAND_MODEL } from './permissions';
import { AssistantService } from './service';

export {
  ASSISTANT_COMPONENT,
  ASSISTANT_PERMISSIONS,
  ASSISTANT_REASON,
  ASSISTANT_SYSTEM,
  ASSISTANT_TITLE,
  MAX_TREES_PER_MESSAGE,
  MOCK_RIGHT_HAND_MODEL,
} from './permissions';
export { HINT_LABEL, STATUS_HEADING, buildAssistantPrompt, statusBlock } from './prompt';
export { AssistantService, titleFromRequest } from './service';
export { cronOf, mockRightHand } from './mockRightHand';

declare module '../core/context' {
  interface Services {
    /** The assistant: its session, grant, model, prompt and daily limit. */
    assistant: AssistantService;
  }
}

/**
 * The assistant (作業名「右腕」, snapshot 20261030_right-hand-spec): the one conversation the
 * home screen talks to. It is an ordinary `chat` whose grant (`ASSISTANT_PERMISSIONS`,
 * `scope.allSessions`) lets it look over and drive every tree; the chat executor
 * (sessions/chat.ts) asks `AssistantService` for its model, prompt and daily limit.
 * `assistant.startWork` moves "create → delegate → send" into the daemon so the words of the
 * human reach the new root unchanged.
 */
export const assistantModule = defineModule({
  name: 'assistant',
  register(ctx) {
    const assistant = new AssistantService(ctx);
    ctx.provide('assistant', assistant);
    ctx.methods.register(
      defineMethod('system.assistant', {
        handler: () => ({ sessionId: assistant.ensure().id }),
      }),
      defineMethod('assistant.startWork', {
        scope: (p) => {
          const projectId =
            p.projectId ?? (p.workspace?.kind === 'worktree' ? p.workspace.projectId : null);
          return { projectIds: projectId ? [projectId] : [] };
        },
        handler: (p, call) => assistant.startWork(p, call.actor),
      }),
    );
    ctx.onClose(assistant.start());
    return {
      start() {
        ctx.service('llm').mock.define(MOCK_RIGHT_HAND_MODEL, mockRightHand, {
          label: 'モック（右腕）',
        });
      },
    };
  },
});
