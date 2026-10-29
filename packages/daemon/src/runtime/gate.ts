import type {
  AutoModeJudge,
  PermissionProfile,
  RunPermission,
  ToolDecider,
  ToolDecisionKind,
} from '@acc/protocol';
import {
  NOTABLE_CATEGORIES,
  ROUTINE_CATEGORIES,
  type ToolCategory,
  type ToolPolicyInput,
  type ToolPolicyResult,
  categoryJa,
  decideToolPermission,
  denialMessage,
} from './policy';
import { approvalDetailFor } from './tools';

/** One decision, as the run records it (`RunController.recordToolDecision`). */
export interface ToolDecisionRecord {
  toolCallId: string | null;
  toolName: string;
  summary: string | null;
  decision: ToolDecisionKind;
  decidedBy: ToolDecider;
  rule: string | null;
  category: string;
  reason: string | null;
  profile: PermissionProfile;
  notable: boolean;
  /** Counted only, no event of its own. */
  routine: boolean;
  /** For classifier decisions: where auto mode judged, when the runtime could tell. */
  judge?: AutoModeJudge;
}

/** Auto mode as the settings allow it for a run (see `Settings.autoMode`). */
export interface GateAutoMode {
  classifierModel: string | null;
  /** Default `server` (the settings' default). */
  judge?: AutoModeJudge;
}

/** A remembered approval that matched (see rules.ts). */
export interface RememberedMatch {
  id: string;
  description: string;
}

export interface ToolGateOptions {
  cwd: string;
  profile: PermissionProfile;
  /**
   * Claude Code auto mode may decide the gray zone (profile is not careful, the setting is
   * on). The runtime still decides whether it can: `useClassifier()` / `useRules()`.
   */
  autoMode?: GateAutoMode | null;
  /** Policy inputs beyond the tool use itself (daemon data paths, the API port, test hooks). */
  policy?: Omit<ToolPolicyInput, 'toolName' | 'input' | 'cwd' | 'profile' | 'blockedPath'>;
  /** The remembered approval matching a tool use, if any. */
  remembered?: (toolName: string, input: unknown) => RememberedMatch | null;
  record?: (d: ToolDecisionRecord) => void;
  /** Called when the gate changes between the classifier and the rules. */
  onPermission?: (p: RunPermission) => void;
}

/**
 * What to do with a tool use:
 * - `allow` / `deny` (with `message` for the agent) / `ask` (a human, via the approval flow)
 * - `defer`: leave it to the runtime's own classifier (Claude Code auto mode). The outcome
 *   arrives later through `report()` (or `settle()` when the tool ran without a report).
 */
export type GateAction = 'allow' | 'deny' | 'ask' | 'defer';

export interface GateResult {
  action: GateAction;
  policy: ToolPolicyResult;
  /** For `deny`: what the agent is told. */
  message: string | null;
  decidedBy: ToolDecider;
  /** For `ask`: why it was not decided automatically (Japanese, for the approval card). */
  reason: string | null;
}

/** A decision the runtime learned of (Claude Code: permission_denied, tool_result_meta). */
export interface ReportedDecision {
  toolCallId: string;
  toolName: string;
  decision: 'allowed' | 'denied';
  decidedBy: ToolDecider;
  reason?: string | null;
  /** The classifier could not answer (e.g. its model is not served): not a judgement. */
  classifierUnavailable?: boolean;
  /** Where auto mode judged (server review or the CLI's own classifier), when known. */
  judge?: AutoModeJudge;
}

const REPEATED_BLOCK_TEXT = {
  ja: '同じ操作が自動の安全判定で繰り返し止められたため、実行しませんでした。別の方法で進めるか、必要だった操作と理由を最終報告に書いてください。',
  en: 'This action was blocked repeatedly by the automatic safety check, so it was not run. Continue another way, or state in your final message what you needed and why.',
};

/** Japanese notes on why the classifier is not deciding (Run.permission.note). */
export const GATE_NOTES = {
  unsupportedModel: 'このモデルでは Claude Code の auto mode を使えないため、規則で判断しています',
  classifierUnavailable: '安全判定（auto mode の分類器）を使えないため、規則で判断しています',
  noClassifierModel:
    'LiteLLM 経由で手元の分類器を使う設定ですが、分類器のモデルが未設定のため、規則で判断しています',
  serverJudgeUnavailable:
    '上流が Anthropic のサーバー判定に対応していないため、手元の分類器で判定しています',
} as const;

/**
 * The tool permission gate of one agent run (architecture.md §2.10), shared by every runtime.
 * Layers, top first:
 *
 * 1. hard rules → deny with a reason (every profile)
 * 2. remembered approvals → allow
 * 3. gray zone: Claude Code's auto mode classifier when the runtime uses it (`defer`), else
 *    the profile's rules (`policy.ts`)
 * 4. what neither decides → ask a human (never in the autonomous profile: deny instead)
 *
 * Every decision is recorded once per tool use (routine allows only as counts).
 */
export class ToolGate {
  readonly profile: PermissionProfile;
  readonly autoMode: Required<GateAutoMode> | null;
  private gate: 'classifier' | 'rules' = 'rules';
  private note: string | null = null;
  /** Where auto mode judges now (the setting, until the runtime sees it fall back). */
  private judgeNow: AutoModeJudge | null;
  private readonly decided = new Map<string, GateResult>();
  private readonly deferred = new Map<
    string,
    { toolName: string; input: unknown; policy: ToolPolicyResult }
  >();

  constructor(private readonly opts: ToolGateOptions) {
    this.profile = opts.profile;
    const a = opts.profile === 'careful' ? null : (opts.autoMode ?? null);
    this.autoMode = a ? { classifierModel: a.classifierModel, judge: a.judge ?? 'server' } : null;
    this.judgeNow = this.autoMode?.judge ?? null;
  }

  get mode(): 'classifier' | 'rules' {
    return this.gate;
  }

  /** Where auto mode judges now (null without auto mode). */
  get judge(): AutoModeJudge | null {
    return this.judgeNow;
  }

  get permission(): RunPermission {
    return {
      profile: this.profile,
      gate: this.gate,
      note: this.note,
      ...(this.gate === 'classifier' && this.judgeNow ? { judge: this.judgeNow } : {}),
    };
  }

  /** The runtime hands the gray zone to its classifier. */
  useClassifier(): void {
    if (!this.autoMode || this.gate === 'classifier') return;
    this.gate = 'classifier';
    this.note = null;
    this.opts.onPermission?.(this.permission);
  }

  /**
   * The runtime saw auto mode leave the server review for the CLI's own classifier (the
   * upstream does not return `safeguard_results`): still auto mode, judged locally.
   */
  judgeLocally(): void {
    if (this.judgeNow !== 'server') return;
    this.judgeNow = 'client';
    if (this.gate !== 'classifier') return;
    this.note = GATE_NOTES.serverJudgeUnavailable;
    this.opts.onPermission?.(this.permission);
  }

  /** The daemon's rules decide from now on (also the fallback when the classifier fails). */
  useRules(note: string | null): void {
    if (this.gate === 'rules' && this.note === note) return;
    this.gate = 'rules';
    this.note = note;
    this.opts.onPermission?.(this.permission);
  }

  /** Decide a tool use before it runs. Repeated checks of one tool use id return the first answer. */
  check(req: {
    toolName: string;
    input: unknown;
    toolUseId?: string;
    blockedPath?: string;
  }): GateResult {
    const cached = req.toolUseId ? this.decided.get(req.toolUseId) : undefined;
    if (cached) return cached;
    const policy = this.policy(req);
    const result = this.decide(req, policy);
    if (req.toolUseId) this.decided.set(req.toolUseId, result);
    if (result.action === 'defer') {
      if (req.toolUseId)
        this.deferred.set(req.toolUseId, { toolName: req.toolName, input: req.input, policy });
    } else {
      this.recordResult(req, result);
    }
    return result;
  }

  /**
   * The runtime asks about a use the gate left to the classifier (Claude Code calls
   * `canUseTool` after the classifier blocked the same action repeatedly). Autonomous: deny,
   * marked for review; other profiles: a human decides.
   */
  escalate(req: { toolName: string; input: unknown; toolUseId?: string }): GateResult {
    const prior = req.toolUseId ? this.deferred.get(req.toolUseId) : undefined;
    if (req.toolUseId) this.deferred.delete(req.toolUseId);
    const policy = prior?.policy ?? this.policy(req);
    const result: GateResult =
      this.profile === 'autonomous'
        ? {
            action: 'deny',
            policy,
            message: denialMessage(REPEATED_BLOCK_TEXT),
            decidedBy: 'classifier',
            reason: '自動の安全判定が繰り返し止めたため拒否（要確認）',
          }
        : {
            action: 'ask',
            policy,
            message: null,
            decidedBy: 'classifier',
            reason: '自動の安全判定が繰り返し止めたため確認が必要',
          };
    if (req.toolUseId) this.decided.set(req.toolUseId, result);
    this.recordResult(req, result, true);
    return result;
  }

  /** An approval the runtime asks for on its own (the mock's `ask` step). */
  asked(req: { toolName: string; input: unknown; toolUseId?: string; reason: string }): void {
    this.emit({
      toolCallId: req.toolUseId ?? null,
      toolName: req.toolName,
      summary: approvalDetailFor(req.toolName, req.input, this.opts.cwd),
      decision: 'asked',
      decidedBy: 'rule',
      rule: null,
      category: 'unknown_tool',
      reason: req.reason,
      profile: this.profile,
      notable: false,
      routine: false,
    });
  }

  /** A decision the runtime learned of for a use the gate deferred (others are ignored). */
  report(d: ReportedDecision): void {
    if (d.classifierUnavailable && this.gate === 'classifier') {
      this.useRules(GATE_NOTES.classifierUnavailable);
    }
    const prior = this.deferred.get(d.toolCallId);
    if (!prior) return;
    this.deferred.delete(d.toolCallId);
    const routine = d.decision === 'allowed' && ROUTINE_CATEGORIES.has(prior.policy.category);
    this.emit({
      toolCallId: d.toolCallId,
      toolName: prior.toolName,
      summary: approvalDetailFor(prior.toolName, prior.input, this.opts.cwd),
      decision: d.decision,
      decidedBy: d.decidedBy,
      rule: null,
      category: prior.policy.category,
      reason:
        d.decision === 'denied'
          ? d.classifierUnavailable
            ? '安全判定を実行できなかったため拒否（判定の失敗）'
            : `自動の安全判定が拒否${d.reason ? `: ${d.reason}` : ''}`
          : null,
      profile: this.profile,
      notable: d.decision === 'denied' || NOTABLE_CATEGORIES.has(prior.policy.category),
      routine,
      ...(d.decidedBy === 'classifier' && d.judge ? { judge: d.judge } : {}),
    });
  }

  /** The tool ran (its result arrived) without a report: the runtime allowed it. */
  settle(toolUseId: string): void {
    const prior = this.deferred.get(toolUseId);
    if (!prior) return;
    const routine = ROUTINE_CATEGORIES.has(prior.policy.category);
    this.report({
      toolCallId: toolUseId,
      toolName: prior.toolName,
      decision: 'allowed',
      decidedBy: routine ? 'runtime' : 'classifier',
    });
  }

  // ---- internals -----------------------------------------------------------------

  private policy(req: {
    toolName: string;
    input: unknown;
    blockedPath?: string;
  }): ToolPolicyResult {
    return decideToolPermission({
      ...this.opts.policy,
      toolName: req.toolName,
      input: req.input,
      cwd: this.opts.cwd,
      profile: this.profile,
      blockedPath: req.blockedPath,
    });
  }

  private decide(req: { toolName: string; input: unknown }, policy: ToolPolicyResult): GateResult {
    const base = { policy, message: null, reason: null };
    if (policy.rule) {
      return {
        ...base,
        action: 'deny',
        message: policy.message,
        decidedBy: 'rule',
        reason: policy.reasonJa,
      };
    }
    const remembered = this.opts.remembered?.(req.toolName, req.input) ?? null;
    if (remembered && policy.decision !== 'allow') {
      return {
        ...base,
        action: 'allow',
        decidedBy: 'remembered',
        reason: `覚えた許可: ${remembered.description}`,
      };
    }
    if (this.gate === 'classifier' && policy.decision === 'allow') {
      // Our own tools and bookkeeping need no classifier; everything else is its call.
      const ours =
        policy.category === 'control_api' ||
        policy.category === 'agent_internal' ||
        policy.category === 'subagent';
      return { ...base, action: ours ? 'allow' : 'defer', decidedBy: ours ? 'rule' : 'classifier' };
    }
    if (policy.decision === 'deny') {
      return {
        ...base,
        action: 'deny',
        message: policy.message,
        decidedBy: 'rule',
        reason: policy.reasonJa,
      };
    }
    if (policy.decision === 'ask')
      return { ...base, action: 'ask', decidedBy: 'rule', reason: policy.reasonJa };
    return { ...base, action: 'allow', decidedBy: 'rule' };
  }

  private recordResult(
    req: { toolName: string; input: unknown; toolUseId?: string },
    r: GateResult,
    escalated = false,
  ): void {
    const category: ToolCategory = r.policy.category;
    const decision: ToolDecisionKind =
      r.action === 'allow' ? 'allowed' : r.action === 'ask' ? 'asked' : 'denied';
    const routine =
      decision === 'allowed' && r.decidedBy === 'rule' && ROUTINE_CATEGORIES.has(category);
    this.emit({
      toolCallId: req.toolUseId ?? null,
      toolName: req.toolName,
      summary: approvalDetailFor(req.toolName, req.input, this.opts.cwd),
      decision,
      decidedBy: r.decidedBy,
      rule: r.policy.rule,
      category,
      reason:
        decision === 'allowed' && r.decidedBy === 'rule' ? null : (r.reason ?? r.policy.reasonJa),
      profile: this.profile,
      notable:
        escalated ||
        r.decidedBy === 'remembered' ||
        NOTABLE_CATEGORIES.has(category) ||
        (decision === 'denied' && r.policy.rule === null),
      routine,
    });
  }

  private emit(d: ToolDecisionRecord): void {
    try {
      this.opts.record?.(d);
    } catch {
      // Recording must never change a decision.
    }
  }
}

/** The approval payload's Japanese reason line for a gate result. */
export function askReason(r: GateResult): string {
  return r.reason ?? `${categoryJa(r.policy.category)}は確認が必要`;
}
