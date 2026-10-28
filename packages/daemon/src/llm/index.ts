import { defineModule } from '../module';

/**
 * LLM Gateway (architecture.md §2.3).
 *
 * Owns methods: models.list.
 *
 * TODO(llm):
 * - OpenAI-compatible `/chat/completions` streaming client pointed at LiteLLM
 *   (settings.litellm.baseUrl / apiKey from `ctx.settings.get()` — never log the key).
 * - Publish streaming fragments with `ctx.bus.publishDelta({ runId, sessionId, messageId, text, index })`.
 * - Report usage { inputTokens, outputTokens, costUsd, costSource } — `reported` when
 *   LiteLLM returns cost, otherwise `estimated` (tokens x price) or `unknown`.
 * - A deterministic mock provider (used by tests and when no baseUrl is configured).
 * - Provide the gateway as a service: `ctx.provide('llm', gateway)`.
 */
export const llmModule = defineModule({
  name: 'llm',
  register(_ctx) {
    // Not implemented yet. Methods owned by this module answer `not_found`
    // ({ reason: "not_implemented" }) until registered here.
  },
});
