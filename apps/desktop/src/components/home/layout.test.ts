import { describe, expect, it } from 'vitest';
import { attention, card, homeTree } from '../../test/fixtures';
import {
  bandSegments,
  heldShape,
  homeShape,
  isSettledTree,
  navOrder,
  neighbourOf,
  stepSelection,
  visibleAttention,
} from './layout';

const counts = (over: Partial<Parameters<typeof bandSegments>[0]> = {}) => ({
  working: 0,
  queued: 0,
  needsYou: 0,
  failed: 0,
  review: 0,
  done: 0,
  stopped: 0,
  ...over,
});

describe('home layout', () => {
  it('shows every attention item up to 6, else 5 and the rest as 「あと N 件」', () => {
    const items = (n: number) => Array.from({ length: n }, () => attention({ id: 'ses_x' }));
    expect(visibleAttention(items(6), false)).toMatchObject({ more: 0 });
    expect(visibleAttention(items(6), false).shown).toHaveLength(6);
    const seven = visibleAttention(items(7), false);
    expect(seven.shown).toHaveLength(5);
    expect(seven.more).toBe(2);
    expect(visibleAttention(items(7), true).shown).toHaveLength(7);
  });

  it('folds a tree whose sessions are all done, idle or stopped and nobody waits on', () => {
    const root = card({ role: 'supervisor', state: 'done' });
    const done = card({ parentId: root.id, depth: 1, state: 'done' });
    const settled = homeTree(root, [done], { counts: counts({ done: 2 }) });
    expect(isSettledTree(settled, [])).toBe(true);
    // An open attention item keeps it open, so does anything working.
    expect(isSettledTree(settled, [attention({ id: done.id, rootSessionId: root.id })])).toBe(false);
    const busy = homeTree(root, [card({ parentId: root.id, depth: 1, state: 'working' })], { counts: counts({ working: 1 }) });
    expect(isSettledTree(busy, [])).toBe(false);
    expect(isSettledTree(homeTree(card({ state: 'supervising' }), [done]), [])).toBe(false);
  });

  it('orders chips by state priority (daemon order within a state) and marks settled lanes compact', () => {
    const a = card({ title: 'A', state: 'supervising' });
    const w1 = card({ parentId: a.id, depth: 1, state: 'working' });
    const ny = card({ parentId: a.id, depth: 1, state: 'needs_you' });
    const w2 = card({ parentId: a.id, depth: 1, state: 'working' });
    const b = card({ title: 'B', state: 'done' });
    const bd = card({ parentId: b.id, depth: 1, state: 'done' });
    const chat = card({ title: 'C', role: 'chat', state: 'idle' });
    const shape = homeShape({
      trees: [homeTree(a, [w1, ny, w2], { counts: counts({ working: 2, needsYou: 1 }) }), homeTree(b, [bd]), homeTree(chat)],
      attention: [],
    });
    expect(shape).toEqual([
      { id: a.id, compact: false, chips: [ny.id, w1.id, w2.id] },
      { id: b.id, compact: true, chips: [bd.id] },
      { id: chat.id, compact: true, chips: [] },
    ]);
  });

  it('holds what is on screen: places and folding stay, newcomers go last, leavers drop', () => {
    const held = [
      { id: 'r1', compact: false, chips: ['a', 'b', 'c'] },
      { id: 'r2', compact: true, chips: ['d'] },
    ];
    const live = [
      { id: 'r3', compact: false, chips: ['x'] },
      { id: 'r2', compact: false, chips: ['e', 'd'] },
      { id: 'r1', compact: false, chips: ['c', 'a'] },
    ];
    expect(heldShape(held, live)).toEqual([
      { id: 'r1', compact: false, chips: ['a', 'c'] },
      { id: 'r2', compact: true, chips: ['d', 'e'] },
      { id: 'r3', compact: false, chips: ['x'] },
    ]);
  });

  it('walks attention rows, then each lane heading and its chips (not the chips of a folded lane)', () => {
    const lanes = [
      { id: 'r1', compact: false, chips: ['a', 'b'] },
      { id: 'r2', compact: true, chips: ['c'] },
      { id: 'r3', compact: false, chips: [] },
    ];
    const ids = navOrder(['att1', 'att2'], lanes);
    expect(ids).toEqual(['att1', 'att2', 'r1', 'a', 'b', 'r2', 'r3']);
    expect(stepSelection(ids, null, 1)).toBe('att1');
    expect(stepSelection(ids, null, -1)).toBe('r3');
    expect(stepSelection(ids, 'att2', 1)).toBe('r1');
    expect(stepSelection(ids, 'r3', 1)).toBe('r3');
    expect(stepSelection(ids, 'att1', -1)).toBe('att1');
    expect(stepSelection(ids, 'gone', 1)).toBe('att1');
    expect(stepSelection([], null, 1)).toBeNull();
  });

  it('moves the selection of an answered row to the next one, or the one before at the end', () => {
    expect(neighbourOf(['a', 'b', 'c'], 'b')).toBe('c');
    expect(neighbourOf(['a', 'b', 'c'], 'c')).toBe('b');
    expect(neighbourOf(['a'], 'a')).toBeNull();
    expect(neighbourOf(['a'], 'x')).toBeNull();
  });

  it('bands the counts in priority order without empty states', () => {
    expect(bandSegments(counts({ done: 1, working: 2, needsYou: 1 }))).toEqual([
      { state: 'needs_you', n: 1 },
      { state: 'working', n: 2 },
      { state: 'done', n: 1 },
    ]);
    expect(bandSegments(counts())).toEqual([]);
  });
});
