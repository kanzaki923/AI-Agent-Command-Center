import type { Approval } from '@acc/protocol';
import { displayPath, toolCategory } from '../lib/tools';

export type Risk = 'normal' | 'high';

export interface ApprovalView {
  /** Question-form heading (§9.3). */
  question: string;
  /** What exactly: command / file / destination (mono evidence). */
  target: string | null;
  targetKind: 'command' | 'file' | 'url' | 'text' | null;
  /** One-line impact (`worktree 内 · 読み取りと実行のみ`). */
  scope: string | null;
  risk: Risk;
  /** The daemon's own risk rating (`payload.risk` of tool approvals), when it gave one. */
  riskLevel: 'low' | 'medium' | 'high' | null;
}

export const RISK_LABEL = { low: '危険度 低', medium: '危険度 中', high: '危険度 高' } as const;

const HIGH_RISK_COMMAND = [
  /\bgit\s+push\b/,
  /\brm\s+-[a-z]*[rf]/i,
  /\bdel\b|\bRemove-Item\b|\brmdir\b/i,
  /\bcurl\b|\bwget\b|\bInvoke-WebRequest\b|\bscp\b|\bssh\b/i,
  /\bgit\s+reset\s+--hard\b/,
  /\bdrop\s+(table|database)\b/i,
  /\bnpm\s+publish\b|\bpnpm\s+publish\b/,
];

interface ToolPayload {
  toolName?: unknown;
  input?: unknown;
  risk?: unknown;
  outsideWorkspace?: unknown;
}

function payloadOf(a: Approval): ToolPayload {
  return a.payload && typeof a.payload === 'object' ? (a.payload) : {};
}

export function describeApproval(a: Approval): ApprovalView {
  const r = payloadOf(a).risk;
  const riskLevel = r === 'low' || r === 'medium' || r === 'high' ? r : r === 'critical' ? 'high' : null;
  return { ...describeBase(a), riskLevel };
}

function describeBase(a: Approval): Omit<ApprovalView, 'riskLevel'> {
  const p = payloadOf(a);
  const input = (p.input && typeof p.input === 'object' ? p.input : {}) as Record<string, unknown>;
  const toolName = typeof p.toolName === 'string' ? p.toolName : null;
  // The daemon's own assessment (payload.risk) wins upward; the client heuristics below can
  // only add caution, never remove it.
  const explicitHigh = p.risk === 'high' || p.risk === 'critical' || p.outsideWorkspace === true;

  if (a.kind === 'integration') {
    return {
      question: '統合結果を反映しますか？',
      target: a.detail,
      targetKind: 'text',
      scope: null,
      risk: 'normal',
    };
  }
  if (a.kind === 'budget') {
    return { question: '予算の追加を承認しますか？', target: a.detail, targetKind: 'text', scope: null, risk: 'normal' };
  }
  if (a.kind === 'grant') {
    return { question: '権限の付与を承認しますか？', target: a.detail, targetKind: 'text', scope: null, risk: 'normal' };
  }
  if (toolName) {
    const cat = toolCategory(toolName);
    if (cat === 'run') {
      const cmd = typeof input.command === 'string' ? input.command : (a.detail ?? toolName);
      const high = explicitHigh || HIGH_RISK_COMMAND.some((re) => re.test(cmd));
      return {
        question: 'コマンドの実行を承認しますか？',
        target: cmd,
        targetKind: 'command',
        scope: high ? '取り消せない操作や外部への送信を含む可能性があります' : 'worktree 内 · 読み取りと実行のみ',
        risk: high ? 'high' : 'normal',
      };
    }
    if (cat === 'edit') {
      const path = (input.file_path ?? input.path) as string | undefined;
      return {
        question: 'ファイルの書き込みを承認しますか？',
        target: path ? displayPath(path) : a.detail,
        targetKind: 'file',
        scope: explicitHigh ? 'worktree の外への書き込みです' : 'worktree 内のファイル',
        risk: explicitHigh ? 'high' : 'normal',
      };
    }
    if (cat === 'web') {
      const url = (input.url ?? input.query) as string | undefined;
      return {
        question: '外部への送信を承認しますか？',
        target: url ?? a.detail,
        targetKind: 'url',
        scope: 'ネットワークに接続します',
        risk: 'high',
      };
    }
  }
  return {
    question: a.title.endsWith('？') || a.title.endsWith('?') ? a.title : `${a.title}を承認しますか？`,
    target: a.detail,
    targetKind: a.detail ? 'text' : null,
    scope: explicitHigh ? 'Core Daemon が危険度「高」と判定した操作です' : null,
    risk: explicitHigh ? 'high' : 'normal',
  };
}
