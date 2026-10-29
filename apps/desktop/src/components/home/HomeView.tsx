import type { HomeTree, SessionCard } from '@acc/protocol';
import { Clock } from 'lucide-react';
import { useState } from 'react';
import { startConversation } from '../../daemon/actions';
import { useHome } from '../../daemon/home';
import { useRuntime } from '../../daemon/runtime';
import { useSlowNow } from '../../hooks/useNow';
import { formatNextRun, sessionTitle, sortByState } from '../../lib/states';
import { useUi } from '../../store/ui';
import { AttentionRow } from '../ui/AttentionRow';
import { CostMeter } from '../ui/CostMeter';
import { RoleIcon } from '../ui/SemanticIcons';
import { SessionChip } from '../ui/SessionChip';
import { StateIcon } from '../ui/StateIcon';

const ATTENTION_SHOWN = 5;

/**
 * The home screen (spec §3), the app's face. Owned by track U1; this is a minimal working
 * version so the app is usable before it: the attention rows on top, then one lane per tree
 * (heading + its children as chips), and a one-line input at the bottom. No props.
 */
export function HomeView() {
  const snap = useHome().data;
  const selectedId = useUi((s) => s.selectedId);
  const [allAttention, setAllAttention] = useState(false);
  if (!snap) return null;
  const titles = new Map<string, string>();
  for (const t of snap.trees) for (const c of [t.root, ...t.nodes]) titles.set(c.id, sessionTitle(c));
  if (snap.trees.length === 0 && snap.attention.length === 0) {
    return (
      <div className="flex h-full items-center justify-center px-8" data-region="main" tabIndex={-1}>
        <div className="w-full max-w-xl">
          <AskInput autoFocus />
        </div>
      </div>
    );
  }
  const many = snap.attention.length > ATTENTION_SHOWN + 1 && !allAttention;
  const attention = many ? snap.attention.slice(0, ATTENTION_SHOWN) : snap.attention;
  return (
    <div className="flex h-full min-h-0 flex-col" data-region="main" tabIndex={-1}>
      <div className="min-h-0 flex-1 overflow-y-auto px-6 pt-4 pb-6">
        {attention.length > 0 && (
          <section aria-label="出番" className="mb-5 flex flex-col gap-1.5">
            {attention.map((a) => (
              <AttentionRow key={a.id} attention={a} sessionTitle={titles.get(a.sessionId)} selected={selectedId === a.id} />
            ))}
            {many && (
              <button
                type="button"
                onClick={() => setAllAttention(true)}
                className="self-start rounded-sm px-2 py-0.5 text-meta text-fg-2 hover:bg-hover hover:text-fg"
              >
                あと {snap.attention.length - ATTENTION_SHOWN} 件
              </button>
            )}
          </section>
        )}
        <div className="flex flex-col gap-4">
          {snap.trees.map((t) => (
            <Lane key={t.root.id} tree={t} selectedId={selectedId} />
          ))}
        </div>
      </div>
      <div className="shrink-0 border-t border-line-subtle px-6 py-3">
        <AskInput />
      </div>
    </div>
  );
}

function Lane({ tree, selectedId }: { tree: HomeTree; selectedId: string | null }) {
  const openSession = useUi((s) => s.openSession);
  const now = useSlowNow();
  const { root } = tree;
  const children = sortByState(tree.nodes.filter((n) => n.depth >= 1), (n) => n.state);
  return (
    <section aria-label={sessionTitle(root)} className="flex flex-col gap-2">
      <div className="flex h-7 min-w-0 items-center gap-2">
        <RoleIcon role={root.role} scheduled={root.startedBy === 'schedule'} className="text-fg-3" />
        <button
          type="button"
          onClick={() => openSession(root.id)}
          className="min-w-0 truncate rounded-sm px-1 text-ui font-medium text-fg hover:bg-hover"
        >
          {sessionTitle(root)}
        </button>
        {children.length === 0 && <StateIcon state={root.state} />}
        {children.length === 0 && root.now && <span className="min-w-0 truncate text-meta text-fg-2">{root.now}</span>}
        <span className="flex-1" />
        {tree.nextRunAt && (
          <span className="flex items-center gap-1 text-meta text-fg-3">
            <Clock size={12} strokeWidth={1.75} aria-label="次回" />
            <span className="tabular">{formatNextRun(tree.nextRunAt, now)}</span>
          </span>
        )}
        <CostMeter usedUsd={tree.spend.treeUsd} limitUsd={tree.spend.limitUsd} estimated={tree.spend.estimated} />
      </div>
      {children.length > 0 && (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(168px,1fr))] gap-2">
          {children.map((c: SessionCard) => (
            <SessionChip key={c.id} card={c} selected={selectedId === c.id} onOpen={openSession} />
          ))}
          {tree.hiddenNodes > 0 && (
            <button
              type="button"
              onClick={() => openSession(root.id)}
              className="flex h-[66px] items-center justify-center rounded-md border border-dashed border-line text-ui text-fg-2 hover:bg-hover"
            >
              +{tree.hiddenNodes}
            </button>
          )}
        </div>
      )}
    </section>
  );
}

/** 何を頼みますか: Enter starts a conversation and stays here; Ctrl+Enter opens it. */
function AskInput({ autoFocus = false }: { autoFocus?: boolean }) {
  const rt = useRuntime();
  const [text, setText] = useState('');
  const send = async (open: boolean) => {
    const t = text.trim();
    if (!t) return;
    setText('');
    const s = await startConversation(rt, { text: t, projectId: useUi.getState().projectId });
    if (s && open) useUi.getState().openSession(s.id);
  };
  return (
    <input
      autoFocus={autoFocus}
      value={text}
      placeholder="何を頼みますか"
      aria-label="何を頼みますか"
      onChange={(e) => setText(e.target.value)}
      onKeyDown={(e) => {
        if (e.nativeEvent.isComposing || e.keyCode === 229) return;
        if (e.key === 'Enter') {
          e.preventDefault();
          void send(e.ctrlKey || e.metaKey);
        }
      }}
      className="h-10 w-full rounded-md border border-line bg-surface px-3 text-chat text-fg placeholder:text-fg-4 focus:border-[var(--focus-ring)]"
    />
  );
}
