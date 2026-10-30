import { defineMethod } from '../api/registry';
import { forbidden } from '../core/errors';
import { defineModule } from '../module';
import { ChatGptAuth, newHostId } from './chatgptAuth';
import { LlmGateway } from './gateway';
import { PriceBook } from './pricing';

export {
  LlmGateway,
  providerOf,
  type ProviderId,
  type CompleteOptions,
  type ModelList,
  type LlmGatewayOptions,
} from './gateway';
export {
  AnthropicProvider,
  AnthropicStreamAccumulator,
  ANTHROPIC_PREFIX,
  toMessagesBody,
  type AnthropicConnection,
} from './anthropic';
export {
  OpenAiResponsesProvider,
  ResponsesStreamAccumulator,
  OPENAI_PREFIX,
  toResponsesBody,
  type OpenAiAuth,
  type OpenAiConnection,
} from './openaiResponses';
export { ChatGptAuth, newHostId, type ChatGptAuthOptions, type ChatGptStore } from './chatgptAuth';
export { fetchSse, retrying } from './http';
export {
  MockProvider,
  MOCK_PREFIX,
  mockCallInfo,
  scripted,
  type MockCallInfo,
  type MockReply,
  type MockResponder,
  type MockModelOptions,
} from './mock';
export {
  OpenAiCompatibleProvider,
  OpenAiStreamAccumulator,
  LITELLM_COST_HEADER,
  toWireRequest,
} from './openai';
export { SseParser, type SseMessage } from './sse';
export {
  PriceBook,
  builtinPrice,
  costOf,
  normalizeModelName,
  type ModelPrice,
  type PriceQuote,
} from './pricing';
export { toChatMessages, stringifyToolOutput, textOfParts } from './messages';
export {
  apiTools,
  methodForToolName,
  paramsJsonSchema,
  toolNameForMethod,
  type ApiToolsOptions,
  type LoopTool,
} from './tools';
export {
  runToolLoop,
  addUsage,
  RunStopError,
  LOOP_REPEATS,
  type ToolLoopOptions,
  type ToolLoopResult,
} from './toolLoop';
export * from './types';

declare module '../core/context' {
  interface Services {
    llm: LlmGateway;
    /** "Sign in with ChatGPT": the plan token the OpenAI provider uses. */
    chatgpt: ChatGptAuth;
  }
}

/**
 * LLM Gateway (architecture.md §2.3): OpenAI-compatible `/chat/completions` streaming
 * against LiteLLM (settings.litellm, read per call) plus the built-in mock provider.
 * Provides `ctx.service('llm')` and the `models.list` method. The tool loop
 * (`runToolLoop`) and API tool generation (`apiTools`) live here too.
 */
export const llmModule = defineModule({
  name: 'llm',
  register(ctx) {
    const prices = new PriceBook({
      connection: () => ctx.settings.get().litellm,
      log: ctx.log.child('pricing'),
      now: () => ctx.clock.now(),
    });
    ctx.provide('pricing', prices);
    const chatgpt = new ChatGptAuth({
      store: {
        get: () => ctx.settings.chatgpt(),
        set: (c) => ctx.settings.setChatGpt(c),
        hostId: () => ctx.settings.chatgptHostId(newHostId),
      },
      log: ctx.log.child('chatgpt'),
      now: () => ctx.clock.now(),
      // Key names only: the UI refetches settings.get, which masks everything.
      onChange: () =>
        ctx.bus.emit({
          type: 'settings.updated',
          actor: { kind: 'system', component: 'chatgpt' },
          payload: { changes: ['providers.openai.chatgpt'] },
        }),
    });
    ctx.provide('chatgpt', chatgpt);
    ctx.onClose(() => chatgpt.close());
    const gateway = new LlmGateway({
      connection: () => ctx.settings.get().litellm,
      anthropic: () => ctx.settings.get().providers.anthropic,
      openai: () => ctx.settings.get().providers.openai,
      chatgptToken: () => chatgpt.accessToken(),
      pricing: prices.lookup,
      defaultModel: () => ctx.settings.get().defaultModel,
      log: ctx.log.child('llm'),
      now: () => ctx.clock.now(),
    });
    ctx.provide('llm', gateway);

    const humansOnly = (actor: { kind: string }) => {
      if (actor.kind !== 'human') throw forbidden('ChatGPT のサインインを扱えるのは人間だけです');
    };
    ctx.methods.register(
      defineMethod('models.list', {
        handler: (p) => gateway.listModels(p.refresh ?? false),
      }),
      defineMethod('chatgpt.signIn', {
        handler: (_p, call) => {
          humansOnly(call.actor);
          return chatgpt.signIn();
        },
      }),
      defineMethod('chatgpt.status', { handler: () => chatgpt.status() }),
      defineMethod('chatgpt.signOut', {
        handler: async (_p, call) => {
          humansOnly(call.actor);
          await chatgpt.signOut();
          return { ok: true as const };
        },
      }),
    );
  },
});
