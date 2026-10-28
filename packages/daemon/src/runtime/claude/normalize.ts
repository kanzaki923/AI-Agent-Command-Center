import type { ContentPart } from '@acc/protocol';
import type { AgentEvent } from '../../contracts';
import { asRecord, asString, describeToolActivity } from '../tools';

/**
 * Claude Agent SDK message stream -> AgentEvent (see
 * docs/snapshot/20261029_claude-agent-sdk-research.md §5). Pure: no SDK import, so it is
 * unit-tested with recorded/fake messages. Unknown message types are ignored.
 */

/** Cumulative usage of one SDK session (the SDK reports running totals, not deltas). */
export interface UsageTotals {
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}
export const ZERO_TOTALS: UsageTotals = { inputTokens: 0, outputTokens: 0, costUsd: 0 };

export type TurnOutcome = { ok: true } | { ok: false; message: string };

const RESULT_ERRORS: Record<string, string> = {
  error_max_turns: 'ターン数の上限に達したため停止しました',
  error_max_budget_usd: '予算の上限に達したため停止しました',
  error_max_structured_output_retries: '出力形式の再試行回数の上限に達しました',
  error_during_execution: '実行中にエラーが発生しました',
};

const ASSISTANT_ERRORS: Record<string, string> = {
  authentication_failed:
    'Claude の認証に失敗しました。Claude Code へのログイン、または LiteLLM の URL / API キーを確認してください',
  oauth_org_not_allowed: 'この組織では Claude Code の利用が許可されていません',
  billing_error: 'Claude の請求情報に問題があります',
  rate_limit: 'レート制限に達しました。しばらく待ってから再試行してください',
  overloaded: 'モデルが混み合っています。しばらく待ってから再試行してください',
  model_not_found: '指定したモデルが見つかりません。モデル名を確認してください',
  invalid_request: 'モデルへのリクエストが拒否されました',
  server_error: 'モデルのサーバーでエラーが発生しました',
  max_output_tokens: '出力トークンの上限に達しました',
};

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

/** Text of a tool_result block's content (string or [{type:'text', text}]). */
function toolResultOutput(content: unknown): unknown {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const texts = content
      .map((c) => asRecord(c))
      .filter((c): c is Record<string, unknown> => c?.type === 'text')
      .map((c) => asString(c.text) ?? '');
    if (texts.length === content.length) return texts.join('\n');
  }
  return content ?? null;
}

export class ClaudeMessageNormalizer {
  /** SDK session id (from system/init or any message carrying session_id). */
  sessionId: string | null = null;
  /** Set when a `result` message arrives. */
  outcome: TurnOutcome | null = null;

  private pending: { id: string; parts: ContentPart[] } | null = null;
  private readonly toolNames = new Map<string, string>();
  private lastAssistantError: string | null = null;
  private totals: UsageTotals;

  constructor(
    private readonly cwd: string,
    /** Totals the SDK session already had before this run (resume), so we report deltas. */
    baseline: UsageTotals = ZERO_TOTALS,
  ) {
    this.totals = { ...baseline };
  }

  /** Latest cumulative totals (persist them as the next run's baseline). */
  get usageTotals(): UsageTotals {
    return { ...this.totals };
  }

  push(raw: unknown): AgentEvent[] {
    const msg = asRecord(raw);
    if (!msg) return [];
    const out: AgentEvent[] = [];
    const sid = asString(msg.session_id);
    if (sid && sid !== this.sessionId && msg.type !== 'system') {
      // Some flows (resume) may not repeat system/init; any message names the session.
      this.sessionId = sid;
      out.push({ type: 'session', runtimeSessionId: sid });
    }
    const parent = msg.parent_tool_use_id;
    const isSubagent = typeof parent === 'string' && parent.length > 0;

    switch (msg.type) {
      case 'system':
        out.push(...this.onSystem(msg));
        break;
      case 'stream_event':
        if (!isSubagent) out.push(...this.onStreamEvent(asRecord(msg.event)));
        break;
      case 'assistant':
        out.push(...this.onAssistant(msg, isSubagent));
        break;
      case 'user':
        out.push(...this.flush());
        out.push(...this.onUser(msg));
        break;
      case 'tool_progress': {
        const name = asString(msg.tool_name);
        if (name) out.push({ type: 'activity', text: describeToolActivity(name, {}, this.cwd) });
        break;
      }
      case 'result':
        out.push(...this.flush());
        out.push(...this.onResult(msg));
        break;
      default:
        break;
    }
    return out;
  }

  /** Flush whatever is buffered (call when the stream ends). */
  finish(): AgentEvent[] {
    return this.flush();
  }

  private onSystem(msg: Record<string, unknown>): AgentEvent[] {
    switch (msg.subtype) {
      case 'init': {
        const sid = asString(msg.session_id);
        const out: AgentEvent[] = [];
        if (sid && sid !== this.sessionId) {
          this.sessionId = sid;
          out.push({ type: 'session', runtimeSessionId: sid });
        }
        out.push({ type: 'activity', text: 'Claude Code を起動しました' });
        return out;
      }
      case 'api_retry':
        return [{ type: 'activity', text: 'モデルの応答を待っています（再試行中）' }];
      case 'compact_boundary':
        return [{ type: 'activity', text: '会話を要約しています' }];
      default:
        return [];
    }
  }

  private onStreamEvent(event: Record<string, unknown> | undefined): AgentEvent[] {
    if (!event) return [];
    switch (event.type) {
      case 'message_start': {
        const id = asString(asRecord(event.message)?.id) ?? null;
        this.streamId = id;
        // A new API response: the previous one is complete.
        return this.pending && this.pending.id !== id ? this.flush() : [];
      }
      case 'content_block_delta': {
        const delta = asRecord(event.delta);
        const text = asString(delta?.text);
        if (delta?.type === 'text_delta' && text && this.streamId) {
          return [{ type: 'text_delta', messageId: this.streamId, text }];
        }
        return [];
      }
      case 'message_stop':
        // Assistant messages (one per content block) arrive before message_stop, so the
        // buffered message is complete; persist it before any approval prompt appears.
        return this.pending && this.pending.id === this.streamId ? this.flush() : [];
      default:
        return [];
    }
  }

  /** Message id of the API response currently streaming (from message_start). */
  private streamId: string | null = null;

  private onAssistant(msg: Record<string, unknown>, isSubagent: boolean): AgentEvent[] {
    const message = asRecord(msg.message);
    const error = asString(msg.error);
    if (error) this.lastAssistantError = error;
    if (!message) return [];
    const id = asString(message.id) ?? `assistant-${Date.now()}`;
    const content = Array.isArray(message.content) ? message.content : [];
    const out: AgentEvent[] = [];
    if (!isSubagent && this.pending && this.pending.id !== id) out.push(...this.flush());

    const parts: ContentPart[] = [];
    for (const raw of content) {
      const block = asRecord(raw);
      if (!block) continue;
      if (block.type === 'text') {
        const text = asString(block.text);
        if (text) parts.push({ type: 'text', text });
      } else if (block.type === 'thinking') {
        const text = asString(block.thinking);
        if (text) parts.push({ type: 'reasoning', text });
      } else if (block.type === 'tool_use') {
        const toolCallId = asString(block.id);
        const name = asString(block.name);
        if (!toolCallId || !name) continue;
        this.toolNames.set(toolCallId, name);
        parts.push({ type: 'tool_call', toolCallId, name, input: block.input ?? {} });
        out.push({ type: 'tool_call', toolCallId, name, input: block.input ?? {} });
        out.push({
          type: 'activity',
          text: describeToolActivity(name, block.input ?? {}, this.cwd),
        });
      }
    }
    // Sub-agent narration stays out of the session transcript; its tool uses are kept.
    if (isSubagent || parts.length === 0) return out;
    if (!this.pending) this.pending = { id, parts: [] };
    this.pending.parts.push(...parts);
    return out;
  }

  private onUser(msg: Record<string, unknown>): AgentEvent[] {
    const content = asRecord(msg.message)?.content;
    if (!Array.isArray(content)) return [];
    const out: AgentEvent[] = [];
    for (const raw of content) {
      const block = asRecord(raw);
      if (block?.type !== 'tool_result') continue;
      const toolCallId = asString(block.tool_use_id);
      if (!toolCallId) continue;
      out.push({
        type: 'tool_result',
        toolCallId,
        name: this.toolNames.get(toolCallId) ?? 'unknown',
        output: toolResultOutput(block.content),
        isError: block.is_error === true,
      });
    }
    return out;
  }

  private onResult(msg: Record<string, unknown>): AgentEvent[] {
    const out: AgentEvent[] = [];
    const usage = this.usageDelta(msg);
    if (usage) out.push(usage);

    const subtype = asString(msg.subtype) ?? 'unknown';
    if (subtype === 'success' && msg.is_error !== true) {
      this.outcome = { ok: true };
    } else {
      const detail = Array.isArray(msg.errors)
        ? msg.errors.filter((e): e is string => typeof e === 'string').join(' / ')
        : '';
      const fromAssistant = this.lastAssistantError
        ? ASSISTANT_ERRORS[this.lastAssistantError]
        : undefined;
      const base = fromAssistant ?? RESULT_ERRORS[subtype] ?? 'Claude Code の実行に失敗しました';
      this.outcome = { ok: false, message: detail ? `${base}: ${detail}` : base };
    }
    return out;
  }

  /** Usage since the previous result (the SDK's numbers are cumulative per SDK session). */
  private usageDelta(msg: Record<string, unknown>): AgentEvent | null {
    const modelUsage = asRecord(msg.modelUsage);
    let input = 0;
    let output = 0;
    const entries = modelUsage ? Object.values(modelUsage) : [];
    if (entries.length > 0) {
      for (const raw of entries) {
        const u = asRecord(raw);
        if (!u) continue;
        input += num(u.inputTokens) + num(u.cacheReadInputTokens) + num(u.cacheCreationInputTokens);
        output += num(u.outputTokens);
      }
    } else {
      const u = asRecord(msg.usage);
      input =
        num(u?.input_tokens) +
        num(u?.cache_read_input_tokens) +
        num(u?.cache_creation_input_tokens);
      output = num(u?.output_tokens);
    }
    const cost = num(msg.total_cost_usd);
    const next: UsageTotals = { inputTokens: input, outputTokens: output, costUsd: cost };
    const prev = this.totals;
    // A `/clear` or a resume without a recorded baseline can make totals go down; never
    // report negative usage.
    const delta = {
      inputTokens: Math.max(0, Math.round(next.inputTokens - prev.inputTokens)),
      outputTokens: Math.max(0, Math.round(next.outputTokens - prev.outputTokens)),
      costUsd: Math.max(0, next.costUsd - prev.costUsd),
    };
    this.totals = next;
    if (delta.inputTokens === 0 && delta.outputTokens === 0 && delta.costUsd === 0) return null;
    return {
      type: 'usage',
      // The CLI computes this from its own price table; it is the runtime's reported figure.
      usage: { ...delta, costSource: 'reported' },
    };
  }

  private flush(): AgentEvent[] {
    const p = this.pending;
    this.pending = null;
    if (!p || p.parts.length === 0) return [];
    return [{ type: 'message', messageId: p.id, role: 'assistant', content: p.parts }];
  }
}
