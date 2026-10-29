import type { Project } from '@acc/protocol';
import { describe, expect, it } from 'vitest';
import { T0, iso, session } from '../../test/fixtures';
import {
  OLDER_AFTER_MS,
  ancestorsOf,
  buildForest,
  childDots,
  groupKeyOf,
  groupTrees,
  isOlder,
  stateCountsLabel,
  visibleRows,
} from './model';

const project = (id: string, name: string): Project => ({
  id,
  name,
  description: null,
  repoPath: null,
  folderPath: null,
  defaultBranch: null,
  defaultModel: null,
  testCommand: null,
  commitAuthor: null,
  permissionProfile: null,
  createdAt: iso(T0),
  updatedAt: iso(T0),
  archivedAt: null,
});

describe('buildForest', () => {
  it('nests children under their parents, oldest first, and orders roots by the activity of their tree', () => {
    const quiet = session({ title: 'quiet', lastActivityAt: iso(T0 + 5_000) });
    const boss = session({ title: 'boss', lastActivityAt: iso(T0) });
    const late = session({ parentSessionId: boss.id, createdAt: iso(T0 + 2), lastActivityAt: iso(T0 + 9_000) });
    const early = session({ parentSessionId: boss.id, createdAt: iso(T0 + 1) });
    const grandchild = session({ parentSessionId: early.id });
    const forest = buildForest([quiet, boss, late, early, grandchild]);
    expect(forest.map((t) => t.session.title)).toEqual(['boss', 'quiet']);
    expect(forest[0]!.children.map((c) => c.session.id)).toEqual([early.id, late.id]);
    expect(forest[0]!.descendants.map((s) => s.id)).toEqual([early.id, grandchild.id, late.id]);
    expect(forest[0]!.activityAt).toBe(iso(T0 + 9_000));
  });

  it('puts pinned roots first and drops children whose parent is gone', () => {
    const a = session({ lastActivityAt: iso(T0 + 10) });
    const pinned = session({ pinned: true });
    const orphan = session({ parentSessionId: 'ses_gone' });
    const archived = session({ archivedAt: iso(T0) });
    expect(buildForest([a, pinned, orphan, archived]).map((t) => t.session.id)).toEqual([pinned.id, a.id]);
  });

  it('is settled only when every session of the tree is', () => {
    const root = session({ state: 'done' });
    const child = session({ parentSessionId: root.id, state: 'working' });
    expect(buildForest([root, child])[0]!.settled).toBe(false);
    expect(buildForest([root, { ...child, state: 'stopped' }])[0]!.settled).toBe(true);
  });
});

describe('older and groups', () => {
  const now = T0 + OLDER_AFTER_MS + 1;
  it('folds trees settled for a week, never pinned ones', () => {
    const old = buildForest([session({ state: 'done' })])[0]!;
    expect(isOlder(old, now)).toBe(true);
    expect(isOlder(old, T0 + 1000)).toBe(false);
    expect(isOlder(buildForest([session({ state: 'done', pinned: true })])[0]!, now)).toBe(false);
    expect(isOlder(buildForest([session({ state: 'working' })])[0]!, now)).toBe(false);
  });

  it('groups by project only with two or more projects, conversations without one first', () => {
    const p1 = project('prj_1', 'ウェブ');
    const p2 = project('prj_2', '資料');
    const free = session({ title: 'free', state: 'working' });
    const inP2 = session({ title: 'p2', projectId: p2.id, state: 'working' });
    const old = session({ title: 'old', projectId: p1.id, state: 'done' });
    const forest = buildForest([free, inP2, old]);
    const ids = new Set([p1.id, p2.id]);

    const two = groupTrees(forest, [p1, p2], (t) => groupKeyOf(t, now, true, ids));
    expect(two.groups.map((g) => [g.project?.name ?? null, g.trees.map((t) => t.session.title)])).toEqual([
      [null, ['free']],
      ['ウェブ', []],
      ['資料', ['p2']],
    ]);
    expect(two.older.map((t) => t.session.title)).toEqual(['old']);

    const one = groupTrees(forest, [p1], (t) => groupKeyOf(t, now, false, new Set([p1.id])));
    expect(one.groups).toHaveLength(1);
    expect(one.groups[0]!.trees.map((t) => t.session.title)).toEqual(['free', 'p2']);
  });
});

describe('visibleRows', () => {
  it('shows children of open nodes only, with the lines that continue past each row', () => {
    const root = session();
    const a = session({ parentSessionId: root.id, createdAt: iso(T0 + 1) });
    const a1 = session({ parentSessionId: a.id });
    const b = session({ parentSessionId: root.id, createdAt: iso(T0 + 2) });
    const tree = buildForest([root, a, a1, b])[0]!;

    expect(visibleRows(tree, () => false).map((r) => r.depth)).toEqual([0]);
    const rows = visibleRows(tree, () => true);
    expect(rows.map((r) => [r.node.session.id, r.depth, r.guides, r.last, r.open])).toEqual([
      [root.id, 0, [], true, true],
      [a.id, 1, [], false, true],
      [a1.id, 2, [true], true, false],
      [b.id, 1, [], true, false],
    ]);
  });
});

describe('ancestorsOf / childDots', () => {
  it('walks up the parents', () => {
    const r = session();
    const c = session({ parentSessionId: r.id });
    const g = session({ parentSessionId: c.id });
    expect([...ancestorsOf([r, c, g], g.id)]).toEqual([c.id, r.id]);
    expect(ancestorsOf([r], null).size).toBe(0);
  });

  it('orders dots by priority, at most six, then +N; the tooltip counts each state', () => {
    const kids = [
      ...Array.from({ length: 5 }, () => session({ state: 'done' })),
      session({ state: 'working' }),
      session({ state: 'needs_you' }),
      session({ state: 'failed' }),
    ];
    expect(childDots(kids)).toEqual({ states: ['needs_you', 'failed', 'working', 'done', 'done', 'done'], more: 2 });
    expect(stateCountsLabel(kids)).toBe('あなたの出番 1 · 失敗 1 · 作業中 1 · 完了 5');
  });
});
