import type { ContentPart } from '@acc/protocol';
import type { AgentEvent } from '../../contracts';
import { asRecord, asString, describeToolActivity } from '../tools';
import { describeGatewayError, gatewayErrorHint } from '../../llm/gatewayErrors';

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

/** `SDKAssistantMessageError` (sdk.d.ts): set on the synthetic message of a failed API call. */
const ASSISTANT_ERRORS: Record<string, string> = {
  authentication_failed:
    'Claude の認証に失敗しました。Claude Code へのログイン、または LiteLLM の URL / API キーを確認してください',
  oauth_org_not_allowed: 'この組織では Claude Code の利用が許可されていません',
  account_on_hold: 'Claude のアカウントが保留中のため利用できません',
  verification_required:
    'Claude のアカウントで本人確認が必要です。ブラウザで Claude にログインして確認してください',
  billing_error: 'Claude の請求情報に問題があります',
  cloud_credential_error: 'クラウドの認証情報（Bedrock / Vertex など）に問題があります',
  rate_limit: 'レート制限に達しました。しばらく待ってから再試行してください',
  overloaded: 'モデルが混み合っています。しばらく待ってから再試行してください',
  model_not_found: '指定したモデルが見つかりません。モデル名を確認してください',
  invalid_request: 'モデルへのリクエストが拒否されました',
  server_error: 'モデルのサーバーでエラーが発生しました',
  max_output_tokens: '出力トークンの上限に達しました',
  unknown: 'モデルの呼び出しでエラーが発生しました',
};

/** Assistant errors that a retry cannot fix (the run is stopped instead of retrying). */
const PERMANENT_API_ERRORS: ReadonlySet<string> = new Set([
  'authentication_failed',
  'oauth_org_not_allowed',
  'account_on_hold',
  'verification_required',
  'billing_error',
]);

/** `TerminalReason` (sdk.d.ts) worth explaining when a turn fails. */
const TERMINAL_REASONS: Record<string, string> = {
  prompt_too_long: '会話がモデルのコンテキストの上限を超えました',
  blocking_limit: '会話がモデルのコンテキストの上限を超えました',
  image_error: '画像を処理できませんでした',
  model_error: 'モデルがエラーを返しました',
  api_error: 'モデルの API がエラーを返しました',
  malformed_tool_use_exhausted: 'モデルが不正なツール呼び出しを繰り返したため停止しました',
  max_turns: 'ターン数の上限に達したため停止しました',
  budget_exhausted: '予算の上限に達したため停止しました',
  structured_output_retry_exhausted: '出力形式の再試行回数の上限に達しました',
  turn_setup_failed: 'Claude Code がターンを開始できませんでした',
  hook_stopped: 'フックによって停止しました',
  stop_hook_prevented: 'フックによって停止しました',
};

/** `ModelUsage.costBasis`: 'unknown' on any model makes the total a guess. */
function costSourceOf(modelUsage: unknown[]): 'estimated' | 'unknown' {
  return modelUsage.some((u) => asRecord(u)?.costBasis === 'unknown') ? 'unknown' : 'estimated';
}

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

/** The classifier's reason without the CLI's boilerplate around it. */
function classifierReason(text: string): string | null {
  const m = /Reason:\s*([^\n]+)/.exec(text);
  const reason = (m?.[1] ?? text).trim();
  return reason ? reason.slice(0, 300) : null;
}

export interface NormalizerOptions {
  /**
   * Tools that must be registered (our in-process MCP tools). When system/init lists tools
   * and one of these is missing, `fatal` is set: the agent would otherwise work without
   * the Control API and not say so.
   */
  expectedTools?: readonly string[];
}

export class ClaudeMessageNormalizer {
  /** SDK session id (from system/init or any message carrying session_id). */
  sessionId: string | null = null;
  /** Set when a `result` message arrives. */
  outcome: TurnOutcome | null = null;
  /** The permission mode system/init reported (auto mode silently falls back to "default"). */
  permissionMode: string | null = null;
  /**
   * Japanese reason the run cannot go on and should be stopped now: our MCP tools did not
   * register, or the API keeps rejecting the credentials (the CLI would retry a 401 ten times
   * with backoff, minutes of "retrying" for an error that never fixes itself).
   */
  fatal: string | null = null;
  /**
   * Cumulative totals to remember for the next resume, or null when there is nothing
   * trustworthy (no result yet, or only a zeroed error result: sdk.d.ts says crash and
   * startup-error results may carry zeroed usage).
   */
  baselineTotals: UsageTotals | null = null;

  private pending: { id: string; parts: ContentPart[] } | null = null;
  private readonly toolNames = new Map<string, string>();
  private lastAssistantError: string | null = null;
  private totals: UsageTotals;

  constructor(
    private readonly cwd: string,
    /** Totals the SDK session already had before this run (resume), so we report deltas. */
    baseline: UsageTotals = ZERO_TOTALS,
    private readonly opts: NormalizerOptions = {},
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
        this.checkTools(msg);
        this.permissionMode = asString(msg.permissionMode) ?? this.permissionMode;
        out.push({ type: 'activity', text: 'Claude Code を起動しました' });
        return out;
      }
      case 'permission_denied': {
        // A denial the CLI made itself (auto mode classifier, mode): not our hook's.
        const toolCallId = asString(msg.tool_use_id);
        const toolName = asString(msg.tool_name);
        if (!toolCallId || !toolName) return [];
        const kind = asString(msg.decision_reason_type);
        const message = asString(msg.message) ?? '';
        return [
          {
            type: 'tool_decision',
            toolCallId,
            toolName,
            decision: 'denied',
            source: kind === 'classifier' ? 'classifier' : kind === 'hook' ? 'hook' : 'runtime',
            reason: classifierReason(asString(msg.decision_reason) ?? message),
            classifierUnavailable: /could not evaluate/i.test(message),
          },
        ];
      }
      case 'api_retry': {
        const error = asString(msg.error);
        const http = typeof msg.error_status === 'number' ? msg.error_status : null;
        if (error && PERMANENT_API_ERRORS.has(error) && !this.fatal) {
          this.fatal = `${ASSISTANT_ERRORS[error]}${http !== null ? `（HTTP ${http}）` : ''}`;
        }
        const attempt = typeof msg.attempt === 'number' ? msg.attempt : null;
        const max = typeof msg.max_retries === 'number' ? msg.max_retries : null;
        const status = http !== null ? `、HTTP ${http}` : '';
        const count = attempt !== null && max !== null ? ` ${attempt}/${max}` : '';
        return [
          { type: 'activity', text: `モデルの応答を待っています（再試行${count}${status}）` },
        ];
      }
      case 'compact_boundary':
        return [{ type: 'activity', text: '会話を要約しています' }];
      default:
        return [];
    }
  }

  private checkTools(init: Record<string, unknown>): void {
    const expected = this.opts.expectedTools ?? [];
    if (expected.length === 0 || !Array.isArray(init.tools)) return;
    const tools = new Set(init.tools.filter((t): t is string => typeof t === 'string'));
    const missing = expected.filter((t) => !tools.has(t));
    if (missing.length === 0) return;
    const servers = Array.isArray(init.mcp_servers) ? init.mcp_servers : [];
    // Still connecting: the tools may come later; only a settled server is a failure.
    if (servers.some((s) => asRecord(s)?.status === 'pending')) return;
    const status = servers
      .map((s) => asRecord(s))
      .map((s) => (s ? `${asString(s.name) ?? '?'}: ${asString(s.status) ?? '?'}` : ''))
      .filter(Boolean)
      .join(', ');
    this.fatal =
      `Control API のツールが Claude Code に登録されなかったため停止しました（未登録: ${missing.join(', ')}` +
      `${status ? `、MCP サーバー: ${status}` : ''}）`;
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
    // Undocumented `tool_result_meta`: who allowed / refused each tool use (optional).
    if (Array.isArray(msg.tool_result_meta)) {
      for (const raw of msg.tool_result_meta) {
        const m = asRecord(raw);
        const d = asRecord(m?.permission_decision);
        const toolCallId = asString(m?.id);
        if (!d || !toolCallId) continue;
        const reasonType = asString(d.reason_type);
        const source = asString(d.source);
        out.push({
          type: 'tool_decision',
          toolCallId,
          toolName: this.toolNames.get(toolCallId) ?? 'unknown',
          decision: d.decision === 'reject' ? 'denied' : 'allowed',
          source:
            reasonType === 'classifier'
              ? 'classifier'
              : reasonType === 'hook' || source === 'hook'
                ? 'hook'
                : source === 'user_temporary'
                  ? 'human'
                  : 'runtime',
        });
      }
    }
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
      this.outcome = { ok: false, message: this.failureMessage(msg, subtype) };
    }
    return out;
  }

  /** Japanese failure text: the most specific cause we know, plus the CLI's own detail. */
  private failureMessage(msg: Record<string, unknown>, subtype: string): string {
    const terminal = asString(msg.terminal_reason);
    const fromAssistant = this.lastAssistantError
      ? ASSISTANT_ERRORS[this.lastAssistantError]
      : undefined;
    // A success subtype with is_error carries the API error text in `result`. Behind LiteLLM
    // it is wrapped ("litellm.BadRequestError: AnthropicException - ...") and an unknown model
    // is a 400 rather than a 404: unwrap it and say what is wrong when we can tell.
    const resultText = subtype === 'success' ? asString(msg.result)?.trim() : undefined;
    const gateway = resultText ? describeGatewayError(resultText) : null;
    const base =
      (gateway ? gatewayErrorHint(gateway) : null) ??
      fromAssistant ??
      (terminal ? TERMINAL_REASONS[terminal] : undefined) ??
      RESULT_ERRORS[subtype] ??
      'Claude Code の実行に失敗しました';
    const details: string[] = [];
    const status = msg.api_error_status;
    if (typeof status === 'number') details.push(`HTTP ${status}`);
    if (Array.isArray(msg.errors)) {
      details.push(
        ...msg.errors
          .filter((e): e is string => typeof e === 'string' && !!e)
          .map((e) => describeGatewayError(e).message),
      );
    }
    if (gateway?.message) {
      const text = gateway.message;
      details.push(text.length > 300 ? `${text.slice(0, 299)}…` : text);
    }
    return details.length > 0 ? `${base}: ${details.join(' / ')}` : base;
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
    const zeroed = next.inputTokens === 0 && next.outputTokens === 0 && next.costUsd === 0;
    const failed = msg.subtype !== 'success' || msg.is_error === true;
    // A zeroed error result says nothing about the session's totals: keep the baseline.
    if (zeroed && failed) return null;
    this.baselineTotals = next;
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
      // The CLI prices tokens with its own table (an estimate, not a bill). "unknown" when it
      // had no price for a model (e.g. a gateway alias): costUSD is then a guess.
      usage: { ...delta, costSource: costSourceOf(entries) },
    };
  }

  private flush(): AgentEvent[] {
    const p = this.pending;
    this.pending = null;
    if (!p || p.parts.length === 0) return [];
    return [{ type: 'message', messageId: p.id, role: 'assistant', content: p.parts }];
  }
}
