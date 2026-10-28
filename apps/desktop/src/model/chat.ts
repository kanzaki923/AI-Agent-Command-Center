import type { Approval, Run } from '@acc/protocol';
import type { StreamingMessage } from '../daemon/deltas';
import type { ChatMessage } from '../daemon/sync';
import { TOOL_CATEGORY_LABEL, type ToolCategory, type ToolDescription, describeTool } from '../lib/tools';

export interface ToolCallView {
  id: string;
  name: string;
  input: unknown;
  output: unknown;
  /** null while the call has no result yet. */
  done: boolean;
  isError: boolean;
  desc: ToolDescription;
  at: string;
  endedAt: string | null;
}

export type ChatBlock =
  | { kind: 'user'; id: string; message: ChatMessage; fromAgent: boolean }
  | { kind: 'assistant'; id: string; text: string; reasoning: string; message: ChatMessage }
  | { kind: 'tools'; id: string; calls: ToolCallView[] }
  | { kind: 'approval'; id: string; approval: Approval }
  | { kind: 'streaming'; id: string; stream: StreamingMessage }
  | { kind: 'run-error'; id: string; run: Run }
  | { kind: 'run-stopped'; id: string; run: Run };

interface Timed {
  at: string;
  block: ChatBlock;
  order: number;
}

/**
 * Turn messages + approvals + live streams into display blocks (§5.2):
 * consecutive tool calls collapse into one group, tool results attach to their call,
 * approvals appear where they were requested, AI-sent user messages are labelled.
 */
export function buildChatBlocks(input: {
  messages: ChatMessage[];
  approvals: Approval[];
  streaming: StreamingMessage[];
  runs: Run[];
}): ChatBlock[] {
  const results = new Map<string, { output: unknown; isError: boolean; at: string }>();
  for (const m of input.messages) {
    for (const p of m.content) {
      if (p.type === 'tool_result') {
        results.set(p.toolCallId, { output: p.output, isError: p.isError, at: m.createdAt });
      }
    }
  }

  const timed: Timed[] = [];
  let order = 0;
  let group: ToolCallView[] | null = null;
  const flushGroup = () => {
    if (group && group.length > 0) {
      timed.push({ at: group[0]!.at, order: order++, block: { kind: 'tools', id: `tools:${group[0]!.id}`, calls: group } });
    }
    group = null;
  };

  for (const m of input.messages) {
    if (m.role === 'tool') continue; // results are attached to their calls
    if (m.role === 'user') {
      flushGroup();
      timed.push({
        at: m.createdAt,
        order: order++,
        block: { kind: 'user', id: m.id, message: m, fromAgent: m.author.kind === 'agent' },
      });
      continue;
    }
    if (m.role === 'system') continue;
    // assistant: split into text and tool-call runs, in order
    let text = '';
    let reasoning = '';
    const pushText = () => {
      if (!text.trim() && !reasoning.trim()) return;
      flushGroup();
      timed.push({
        at: m.createdAt,
        order: order++,
        block: { kind: 'assistant', id: `${m.id}:${order}`, text, reasoning, message: m },
      });
      text = '';
      reasoning = '';
    };
    for (const p of m.content) {
      if (p.type === 'text') text += (text ? '\n\n' : '') + p.text;
      else if (p.type === 'reasoning') reasoning += p.text;
      else if (p.type === 'tool_call') {
        pushText();
        const r = results.get(p.toolCallId);
        group ??= [];
        group.push({
          id: p.toolCallId,
          name: p.name,
          input: p.input,
          output: r?.output,
          done: !!r,
          isError: r?.isError ?? false,
          desc: describeTool(p.name, p.input),
          at: m.createdAt,
          endedAt: r?.at ?? null,
        });
      }
    }
    pushText();
  }
  flushGroup();

  for (const a of input.approvals) {
    timed.push({ at: a.createdAt, order: order++, block: { kind: 'approval', id: `apr:${a.id}`, approval: a } });
  }
  for (const r of input.runs) {
    if (r.status === 'failed' && r.endedAt) {
      timed.push({ at: r.endedAt, order: order++, block: { kind: 'run-error', id: `err:${r.id}`, run: r } });
    } else if (r.status === 'cancelled' && r.endedAt && r.kind === 'chat') {
      timed.push({ at: r.endedAt, order: order++, block: { kind: 'run-stopped', id: `stop:${r.id}`, run: r } });
    }
  }

  timed.sort((a, b) => a.at.localeCompare(b.at) || a.order - b.order);
  const blocks = timed.map((t) => t.block);
  // Streams always render last (they are the newest content).
  for (const s of input.streaming) blocks.push({ kind: 'streaming', id: `stream:${s.messageId}`, stream: s });
  return blocks;
}

/** `ツール実行 6 件 · 読み取り 4 · 検索 2` */
export function summarizeTools(calls: ToolCallView[]): string {
  const counts = new Map<ToolCategory, number>();
  for (const c of calls) counts.set(c.desc.category, (counts.get(c.desc.category) ?? 0) + 1);
  const parts = [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([cat, n]) => `${TOOL_CATEGORY_LABEL[cat]} ${n}`);
  return [`ツール実行 ${calls.length} 件`, ...parts].join(' · ');
}

export function toolDurationMs(c: ToolCallView): number | null {
  if (!c.endedAt) return null;
  return Math.max(0, Date.parse(c.endedAt) - Date.parse(c.at));
}

export function formatDuration(ms: number | null): string {
  if (ms == null) return '';
  if (ms < 1000) return `${(ms / 1000).toFixed(1)}s`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60_000)}m${Math.round((ms % 60_000) / 1000)}s`;
}
