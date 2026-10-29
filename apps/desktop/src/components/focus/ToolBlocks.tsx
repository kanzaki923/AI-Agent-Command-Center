import { ChevronRight, CircleX, FileSearch, FilePen, Globe, Hourglass, Search, ShieldBan, Terminal, Wrench, Workflow } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { type ReactNode, useState } from 'react';
import { cn } from '../../lib/cn';
import { TOOL_CATEGORY_LABEL, type ToolCategory, outputText } from '../../lib/tools';
import { toolMethod } from './conversation';
import { type ToolCallView, formatDuration, isBlocked, toolDurationMs } from '../../model/chat';
import { DECIDER, PROFILE_INFO, type ToolDecided, deciderTooltip, describeDecision } from '../../model/permissions';
import { Tooltip } from '../ui/Tooltip';

const ICON: Record<ToolCategory, ReactNode> = {
  read: <FileSearch size={14} strokeWidth={1.5} />,
  search: <Search size={14} strokeWidth={1.5} />,
  edit: <FilePen size={14} strokeWidth={1.5} />,
  run: <Terminal size={14} strokeWidth={1.5} />,
  web: <Globe size={14} strokeWidth={1.5} />,
  control: <Workflow size={14} strokeWidth={1.5} />,
  wait: <Hourglass size={14} strokeWidth={1.5} />,
  other: <Wrench size={14} strokeWidth={1.5} />,
};

export function toolIcon(c: ToolCategory): ReactNode {
  return ICON[c];
}

/** Expand/collapse: height auto 180ms, content fades in 40ms later (§3.2). */
function Expand({ open, children }: { open: boolean; children: ReactNode }) {
  return (
    <AnimatePresence initial={false}>
      {open && (
        <motion.div
          initial={{ height: 0, opacity: 0 }}
          animate={{ height: 'auto', opacity: 1, transition: { height: { duration: 0.18, ease: [0.16, 1, 0.3, 1] }, opacity: { duration: 0.12, delay: 0.04 } } }}
          exit={{ height: 0, opacity: 0, transition: { duration: 0.12, ease: [0.4, 0, 1, 1] } }}
          className="overflow-hidden"
        >
          {children}
        </motion.div>
      )}
    </AnimatePresence>
  );
}

function Pane({ label, text, error }: { label: string; text: string; error?: boolean }) {
  const [full, setFull] = useState(false);
  if (!text) return null;
  return (
    <div className="flex flex-col gap-1">
      <div className="text-micro text-fg-3">{label}</div>
      <pre
        className={cn(
          'selectable overflow-auto rounded-sm bg-canvas px-2.5 py-2 font-mono text-code whitespace-pre-wrap',
          error ? 'text-st-failed' : 'text-fg-2',
          !full && 'max-h-80',
        )}
      >
        {text}
      </pre>
      {!full && text.split('\n').length > 16 && (
        <button type="button" className="self-start text-meta text-accent hover:underline" onClick={() => setFull(true)}>
          全文を開く
        </button>
      )}
    </div>
  );
}

/** One value as a person reads it: strings as they are, lists and objects as indented lines. */
function readable(value: unknown, indent = ''): string {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') return String(value);
  if (typeof value !== 'object') return '';
  if (Array.isArray(value)) {
    return value.map((v) => `${indent}- ${readable(v, `${indent}  `).trimStart()}`).join('\n');
  }
  return Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v != null && v !== '')
    .map(([k, v]) => {
      const text = readable(v, `${indent}  `);
      if (typeof v === 'object') return `${indent}${k}:\n${text}`;
      return text.includes('\n') ? `${indent}${k}:\n${text.replace(/^/gm, `${indent}  `)}` : `${indent}${k}: ${text}`;
    })
    .join('\n');
}

/** A tool's input without braces and quotes (a command reads as `$ command`). */
export function inputText(input: unknown): string {
  if (input == null) return '';
  if (typeof input === 'string') return input;
  const o = input as Record<string, unknown>;
  if (typeof o.command === 'string') return `$ ${o.command}`;
  return readable(input);
}

/** A tool's output: text as it is, structured results as readable lines. */
export function outputOf(output: unknown): string {
  if (output && typeof output === 'object' && !Array.isArray(output) && !('text' in output)) return readable(output);
  const text = outputText(output);
  // JSON text (Control API results): readable lines too.
  if (/^\s*[[{]/.test(text)) {
    try {
      return readable(JSON.parse(text));
    } catch {
      return text;
    }
  }
  return text;
}

/** Group header: `2 人に依頼 · 読み取り 4 · 検索 2`. */
export function summarizeCalls(calls: ToolCallView[]): string {
  const parts = new Map<string, number>();
  let spawns = 0;
  for (const c of calls) {
    if (toolMethod(c.name) === 'session.spawn') spawns++;
    else {
      const label = TOOL_CATEGORY_LABEL[c.desc.category];
      parts.set(label, (parts.get(label) ?? 0) + 1);
    }
  }
  const out = [...parts.entries()].sort((a, b) => b[1] - a[1]).map(([label, n]) => `${label} ${n}`);
  if (spawns) out.unshift(`${spawns} 人に依頼`);
  return out.join(' · ');
}

/** `ブロック` — the daemon stopped this use. Neutral on purpose: nothing for a human to do. */
export function BlockedChip() {
  return (
    <span className="shrink-0 rounded-xs border border-line px-1 text-micro text-fg-2" data-testid="blocked-chip">
      ブロック
    </span>
  );
}

/** The expanded "判断" pane: who decided, why, under which profile. */
function DecisionPane({ decision }: { decision: ToolDecided }) {
  const v = describeDecision(decision);
  return (
    <div className="flex flex-col gap-1">
      <div className="text-micro text-fg-3">判断</div>
      <div className="rounded-sm bg-canvas px-2.5 py-2 text-meta text-fg-2">
        <div>
          {v.label} · {v.deciderTooltip}（{PROFILE_INFO[decision.profile].label}）
        </div>
        {v.fullReason && <div className="mt-0.5 whitespace-pre-wrap text-fg-3">{v.fullReason}</div>}
      </div>
    </div>
  );
}

/** One tool call line (32px): `▸ icon 動詞+対象  補足  所要時間`. */
export function ToolLine({ call, nested = false }: { call: ToolCallView; nested?: boolean }) {
  const [open, setOpen] = useState(false);
  const d = call.desc;
  const dur = formatDuration(toolDurationMs(call) || null);
  const out = outputOf(call.output);
  const blocked = isBlocked(call);
  // A block is not the agent failing: it reads the reason and carries on.
  const failed = call.isError && !blocked;
  const reason = blocked && call.decision ? describeDecision(call.decision).reason : null;
  return (
    <div className={cn(!nested && 'rounded-md border border-line-subtle bg-surface')} data-blocked={blocked || undefined}>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className={cn(
          'flex h-8 w-full items-center gap-2 rounded-md px-2.5 text-left text-ui hover:bg-hover',
          failed ? 'text-st-failed' : 'text-fg-2',
        )}
      >
        <ChevronRight
          size={12}
          strokeWidth={1.75}
          className={cn('shrink-0 text-fg-4 transition-transform duration-[120ms]', open && 'rotate-90')}
        />
        <span className={cn('shrink-0', failed ? 'text-st-failed' : blocked ? 'text-fg-2' : 'text-fg-3')}>
          {blocked ? <ShieldBan size={14} strokeWidth={1.5} /> : failed ? <CircleX size={14} strokeWidth={1.5} /> : ICON[d.category]}
        </span>
        <span className="flex min-w-0 flex-1 items-center gap-2">
          <span className="min-w-0 shrink truncate">{d.label}</span>
          {blocked && <BlockedChip />}
          {blocked && reason && <span className="min-w-0 flex-1 truncate text-fg-3">{reason}</span>}
          {failed && out && <span className="min-w-0 truncate text-st-failed">{out.split('\n')[0]}</span>}
        </span>
        {d.additions != null && d.deletions != null && (
          <span className="shrink-0 font-mono text-meta tabular">
            <span className="text-st-completed">+{d.additions}</span>{' '}
            <span className="text-st-failed">{`−${d.deletions}`}</span>
          </span>
        )}
        {blocked && call.decision && (
          <Tooltip content={deciderTooltip(call.decision)}>
            <span className="shrink-0 text-meta text-fg-3">{DECIDER[call.decision.decidedBy].badge}</span>
          </Tooltip>
        )}
        {!call.done && <span className="shrink-0 text-meta text-fg-3">実行中…</span>}
        {dur && <span className="w-10 shrink-0 text-right text-meta text-fg-3 tabular">{dur}</span>}
      </button>
      <Expand open={open}>
        <div className="flex flex-col gap-2 px-3 pt-1 pb-3">
          <Pane label="入力" text={inputText(call.input)} />
          {call.decision && <DecisionPane decision={call.decision} />}
          {/* A block's output is the reason the agent got: the 判断 pane already shows it. */}
          {!blocked && <Pane label={call.isError ? 'エラー' : '出力'} text={out} error={call.isError} />}
        </div>
      </Expand>
    </div>
  );
}

/** Consecutive calls collapse into "ツール実行 N 件 · 読み取り 4 · 検索 2". */
export function ToolGroup({ calls }: { calls: ToolCallView[] }) {
  const [open, setOpen] = useState(false);
  if (calls.length === 1) return <ToolLine call={calls[0]!} />;
  const blocked = calls.filter(isBlocked);
  const failed = calls.filter((c) => c.isError && !isBlocked(c));
  const total = calls.reduce((n, c) => n + (toolDurationMs(c) ?? 0), 0);
  const running = calls.some((c) => !c.done);
  return (
    <div className="rounded-md border border-line-subtle bg-surface">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="flex h-8 w-full items-center gap-2 rounded-md px-2.5 text-left text-ui text-fg-2 hover:bg-hover"
      >
        <ChevronRight
          size={12}
          strokeWidth={1.75}
          className={cn('shrink-0 text-fg-4 transition-transform duration-[120ms]', open && 'rotate-90')}
        />
        <span className="shrink-0 text-fg-3">
          <Wrench size={14} strokeWidth={1.5} />
        </span>
        <span className="min-w-0 flex-1 truncate">{summarizeCalls(calls)}</span>
        {blocked.length > 0 && (
          <span className="shrink-0 rounded-xs border border-line px-1 text-micro text-fg-2 tabular">
            ブロック {blocked.length}
          </span>
        )}
        {failed.length > 0 && <span className="shrink-0 text-meta text-st-failed">失敗 {failed.length}</span>}
        {running && <span className="shrink-0 text-meta text-fg-3">実行中…</span>}
        {total > 0 && <span className="w-10 shrink-0 text-right text-meta text-fg-3 tabular">{formatDuration(total)}</span>}
      </button>
      <Expand open={open}>
        <div className="flex flex-col border-t border-line-subtle py-1">
          {calls.map((c) => (
            <ToolLine key={c.id} call={c} nested />
          ))}
        </div>
      </Expand>
    </div>
  );
}
