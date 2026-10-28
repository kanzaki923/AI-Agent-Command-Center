import { defineMethod } from '../api/registry';
import { defineModule } from '../module';
import { LlmGateway } from './gateway';

export {
  LlmGateway,
  type CompleteOptions,
  type ModelList,
  type LlmGatewayOptions,
} from './gateway';
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
export { toChatMessages, stringifyToolOutput, textOfParts } from './messages';
export {
  apiTools,
  methodForToolName,
  paramsJsonSchema,
  toolNameForMethod,
  type ApiToolsOptions,
  type LoopTool,
} from './tools';
export { runToolLoop, addUsage, type ToolLoopOptions, type ToolLoopResult } from './toolLoop';
export * from './types';

declare module '../core/context' {
  interface Services {
    llm: LlmGateway;
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
    const gateway = new LlmGateway({
      connection: () => ctx.settings.get().litellm,
      defaultModel: () => ctx.settings.get().defaultModel,
      log: ctx.log.child('llm'),
      now: () => ctx.clock.now(),
    });
    ctx.provide('llm', gateway);

    ctx.methods.register(
      defineMethod('models.list', {
        handler: (p) => gateway.listModels(p.refresh ?? false),
      }),
    );
  },
});
