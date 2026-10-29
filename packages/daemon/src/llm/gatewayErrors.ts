/**
 * Error texts as a real LiteLLM Proxy reshapes them (observed with LiteLLM 1.106 in front of
 * an Anthropic-style upstream, on both `/chat/completions` and `/v1/messages`;
 * docs/snapshot/20261029_litellm-contract.md):
 *
 * - a provider error is wrapped as
 *   `litellm.BadRequestError: AnthropicException - b'{"type":"error","error":{...}}'` followed
 *   by `\n\nLiteLLM: model group 'x' failed with the error above. No fallback was attempted.`;
 * - a model LiteLLM does not serve is HTTP 400 "Invalid model name passed in model=x" (not 404);
 * - after an upstream 401 / 404 LiteLLM cools the deployment down: the next calls get HTTP 429
 *   "No deployments available for selected model ... in cooldown" without reaching upstream.
 *
 * This turns them into the provider's own message plus what kind of failure it is, so the
 * gateway and the Claude runtime can explain it in Japanese.
 */
export interface GatewayErrorInfo {
  /** The provider's message without LiteLLM's wrapping (may be the whole text). */
  message: string;
  kind: 'model_not_found' | 'cooldown' | null;
  /** The model name LiteLLM did not know (model_not_found). */
  model?: string;
}

const WRAPPED = /litellm\.\w+:\s*\w+?(?:Exception|Error)\s*-\s*(?:b')?(\{[\s\S]*\})'?/;
const MODEL_NOT_FOUND = /Invalid model name passed in model=(\S+?)\.?(?:\s|$)/;
const COOLDOWN = /No deployments available for selected model|all_deployments_in_cooldown/;

export function describeGatewayError(text: string): GatewayErrorInfo {
  let message = text
    .replace(/\s*LiteLLM: model group [\s\S]*$/, '')
    .replace(/\.?\s*Handle with `litellm\.\w+`\.?\s*$/, '')
    .trim();
  // Keep what comes before the wrapper (the CLI prefixes "API Error: 400 ").
  message = message.replace(
    WRAPPED,
    (whole: string, json: string) => providerMessage(json) ?? whole,
  );
  const model = MODEL_NOT_FOUND.exec(text)?.[1];
  if (model) return { message, kind: 'model_not_found', model };
  if (COOLDOWN.test(text)) return { message, kind: 'cooldown' };
  return { message, kind: null };
}

/** `{"type":"error","error":{"message"}}` (Anthropic) or `{"error":{"message"}}` / `{"message"}`. */
function providerMessage(json: string): string | null {
  try {
    const parsed = JSON.parse(json) as { error?: { message?: unknown }; message?: unknown };
    const m = parsed.error?.message ?? parsed.message;
    return typeof m === 'string' && m.trim() ? m.trim() : null;
  } catch {
    return null;
  }
}

/** Japanese explanation for the kinds above (null: nothing specific to say). */
export function gatewayErrorHint(info: GatewayErrorInfo): string | null {
  switch (info.kind) {
    case 'model_not_found':
      return `LiteLLM にモデル「${info.model ?? ''}」がありません。LiteLLM の model_list と、設定・チャットのモデル名を確認してください`;
    case 'cooldown':
      return 'LiteLLM が直前の失敗（認証エラーなど）のため、このモデルへの送信を数秒間止めています。少し待ってから再試行してください';
    default:
      return null;
  }
}
