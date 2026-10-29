import type { Attention, HomeTree } from '@acc/protocol';
import { motion } from 'motion/react';
import { useRef, useState } from 'react';
import { type AttentionAnswer, respondAttention } from '../../daemon/attention';
import { useHome } from '../../daemon/home';
import { useRuntime } from '../../daemon/runtime';
import { useWindowKeydown } from '../../hooks/useWindowKeydown';
import { overlayOpen } from '../../lib/overlay';
import { isTypingTarget } from '../../lib/shortcuts';
import { sessionTitle } from '../../lib/states';
import { useUi } from '../../store/ui';
import { attentionKeyAction } from '../ui/AttentionRow';
import { AttentionColumn } from './AttentionColumn';
import { HomeComposer } from './HomeComposer';
import { LAYOUT_SPRING, Lane } from './Lane';
import { homeShape, navOrder, neighbourOf, stepSelection, visibleAttention } from './layout';
import { useShapeHold } from './useShapeHold';

/**
 * The home screen (spec §3), the app's face: where the human is needed on top, then one lane
 * per conversation tree (heading with its state band, children as chips; settled trees folded
 * to their heading), and 何を頼みますか at the bottom. With nothing yet, only that field, in
 * the middle. Places hold still under the pointer and the keyboard; J / K walk everything,
 * Enter opens, 1–4 / Y / N answer the selected attention row. No props.
 */
export function HomeView() {
  const snap = useHome().data;
  if (!snap) return null;
  if (snap.trees.length === 0 && snap.attention.length === 0) {
    return (
      <div className="flex h-full items-center justify-center px-8" data-region="main" tabIndex={-1}>
        <div className="w-full max-w-xl -translate-y-8">
          <HomeComposer center />
        </div>
      </div>
    );
  }
  return <Board trees={snap.trees} attention={snap.attention} />;
}

function Board({ trees, attention }: { trees: HomeTree[]; attention: Attention[] }) {
  const rt = useRuntime();
  const selectedId = useUi((s) => s.selectedId);
  const openSession = useUi((s) => s.openSession);
  const [allAttention, setAllAttention] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  const hold = useShapeHold(homeShape({ trees, attention }));
  const { shown, more } = visibleAttention(attention, allAttention);
  const attentionIds = shown.map((a) => a.id);
  const order = navOrder(attentionIds, hold.lanes);
  const treeById = new Map(trees.map((t) => [t.root.id, t]));
  const titles = new Map<string, string>();
  for (const t of trees) for (const c of [t.root, ...t.nodes]) titles.set(c.id, sessionTitle(c));

  /** Put the keyboard where the selection is: an attention row takes focus (it answers its own keys). */
  const reveal = (id: string) => {
    requestAnimationFrame(() => {
      const root = rootRef.current;
      if (!root) return;
      const sel = CSS.escape(id);
      const row = root.querySelector<HTMLElement>(`[data-attention-row="${sel}"]`);
      if (row) {
        row.focus({ preventScroll: true });
        row.scrollIntoView({ block: 'nearest' });
        return;
      }
      if (document.activeElement?.closest('[data-attention-row]')) root.focus({ preventScroll: true });
      root.querySelector<HTMLElement>(`[data-lane-root="${sel}"], [data-session-chip="${sel}"]`)?.scrollIntoView({ block: 'nearest' });
    });
  };

  const selectByKeyboard = (id: string | null) => {
    useUi.getState().select(id, true);
    hold.noteKeyboard();
    if (id) reveal(id);
  };

  // Answering the selected row moves the selection to the next item waiting for you.
  const respond = (a: Attention, answer: AttentionAnswer) => {
    if (useUi.getState().selectedId === a.id) selectByKeyboard(neighbourOf(attentionIds, a.id));
    void respondAttention(rt, a, answer);
  };

  useWindowKeydown((e) => {
    if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return;
    if (isTypingTarget(e.target) || overlayOpen() || useUi.getState().paletteOpen) return;
    const key = e.key;
    if (key === 'j' || key === 'J' || key === 'ArrowDown' || key === 'k' || key === 'K' || key === 'ArrowUp') {
      e.preventDefault();
      const dir = key === 'j' || key === 'J' || key === 'ArrowDown' ? 1 : -1;
      selectByKeyboard(stepSelection(order, selectedId, dir));
      return;
    }
    if (!selectedId || !order.includes(selectedId)) return;
    const a = shown.find((x) => x.id === selectedId);
    if (a) {
      // The row was not focused (it answers its keys itself when it is): hand the key over.
      const act = attentionKeyAction(a, key);
      if (!act) {
        // Nothing to answer by text: Enter opens the conversation it comes from.
        if (key === 'Enter' && !(e.target instanceof HTMLButtonElement)) {
          e.preventDefault();
          openSession(a.sessionId);
        }
        return;
      }
      e.preventDefault();
      if (act.kind === 'choice') respond(a, { choiceId: act.choice.id });
      else {
        const row = rootRef.current?.querySelector<HTMLElement>(`[data-attention-row="${CSS.escape(a.id)}"]`);
        row?.focus({ preventScroll: true });
        row?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
      }
      return;
    }
    // A focused button opens itself on Enter.
    if (key === 'Enter' && !(e.target instanceof HTMLButtonElement)) {
      e.preventDefault();
      openSession(selectedId);
    }
  });

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div
        ref={rootRef}
        data-region="main"
        tabIndex={-1}
        className="min-h-0 flex-1 overflow-y-auto px-6 pt-4 pb-6 outline-none focus-visible:shadow-none"
        {...hold.bind}
      >
        <AttentionColumn
          shown={shown}
          more={more}
          titles={titles}
          selectedId={selectedId}
          onRespond={respond}
          onShowAll={() => setAllAttention(true)}
        />
        <div className={shown.length > 0 ? 'mt-5 flex flex-col' : 'flex flex-col'}>
          {hold.lanes.map((shape, i) => {
            const tree = treeById.get(shape.id);
            if (!tree) return null;
            // Folded lanes sit close together; full lanes get room.
            const prev = hold.lanes[i - 1];
            const tight = i > 0 && isFolded(shape, tree) && prev && isFolded(prev, treeById.get(prev.id));
            return (
              <motion.div
                key={shape.id}
                layout="position"
                transition={{ layout: LAYOUT_SPRING }}
                className={i === 0 ? '' : tight ? 'mt-0.5' : 'mt-4'}
              >
                <Lane tree={tree} shape={shape} selectedId={selectedId} onOpen={openSession} />
              </motion.div>
            );
          })}
        </div>
      </div>
      <div className="shrink-0 border-t border-line-subtle px-6 py-3">
        <HomeComposer />
      </div>
    </div>
  );
}

function isFolded(shape: { compact: boolean; chips: string[] }, tree: HomeTree | undefined): boolean {
  return shape.compact || (shape.chips.length === 0 && (tree?.hiddenNodes ?? 0) === 0);
}
