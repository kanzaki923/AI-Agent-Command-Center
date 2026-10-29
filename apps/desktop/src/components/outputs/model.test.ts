import { describe, expect, it } from 'vitest';
import { T0, integration, iso } from '../../test/fixtures';
import { output } from './fixtures';
import {
  adoptionOf,
  cellText,
  dockedPanelQuery,
  doneWhenMet,
  formatSize,
  joinPath,
  panelOutputs,
  parseCsv,
  previewKind,
  reviewPhase,
} from './model';

const ME = 'ses_00000000000000000000000001';
const CHILD = 'ses_00000000000000000000000002';
const OTHER = 'ses_00000000000000000000000009';
const pending = { state: 'pending' as const, by: null, at: null, note: null };
const HUMAN = { kind: 'human' as const, client: 'test' };

describe('panelOutputs', () => {
  it('keeps the outputs of the subtree, newest first, those waiting for a decision on top', () => {
    const old = output('document', { sessionId: ME, createdAt: iso(T0) });
    const waiting = output('link', { sessionId: CHILD, createdAt: iso(T0 + 1), review: pending });
    const fresh = output('data', { sessionId: CHILD, createdAt: iso(T0 + 2) });
    const elsewhere = output('document', { sessionId: OTHER });
    const evidence = output('test_result', { sessionId: ME });
    const shown = panelOutputs([old, waiting, fresh, elsewhere, evidence], new Set([ME, CHILD]));
    expect(shown.map((o) => o.id)).toEqual([waiting.id, fresh.id, old.id]);
    expect(shown.map((o) => o.uiKind)).toEqual(['link', 'data', 'document']);
  });

  it('shows only the newest code change of a workspace', () => {
    const first = output('diff', { sessionId: CHILD, workspaceId: 'wsp_1', createdAt: iso(T0) });
    const second = output('diff', {
      sessionId: CHILD,
      workspaceId: 'wsp_1',
      createdAt: iso(T0 + 5),
    });
    expect(panelOutputs([first, second], new Set([CHILD])).map((o) => o.id)).toEqual([second.id]);
  });

  it('drops an output sent back once its conversation has a newer one', () => {
    const sentBack = output('document', {
      sessionId: CHILD,
      createdAt: iso(T0),
      review: { state: 'rejected', by: HUMAN, at: iso(T0), note: '短く' },
    });
    expect(panelOutputs([sentBack], new Set([CHILD]))).toHaveLength(1);
    const redone = output('document', { sessionId: CHILD, createdAt: iso(T0 + 9) });
    expect(panelOutputs([sentBack, redone], new Set([CHILD])).map((o) => o.id)).toEqual([
      redone.id,
    ]);
  });
});

describe('reviewPhase', () => {
  const code = () =>
    output('diff', { sessionId: CHILD, workspaceId: 'wsp_1', review: pending, createdAt: iso(T0) });
  const adopted = (over: Parameters<typeof integration>[0]) =>
    integration({
      workspaceIds: ['wsp_1'],
      preApprovedBy: HUMAN,
      createdAt: iso(T0 + 10),
      ...over,
    });

  it('reads the review state of outputs that need no integration', () => {
    expect(reviewPhase(output('document'), [])).toEqual({ kind: 'none' });
    expect(reviewPhase(output('document', { review: pending }), [])).toEqual({ kind: 'waiting' });
    expect(
      reviewPhase(output('document', { review: { ...pending, state: 'accepted' } }), []),
    ).toEqual({ kind: 'adopted' });
    expect(
      reviewPhase(output('document', { review: { ...pending, state: 'rejected' } }), []),
    ).toEqual({ kind: 'sent_back' });
  });

  it('follows the integration an adoption of code started', () => {
    const c = code();
    expect(reviewPhase(c, []).kind).toBe('waiting');
    expect(reviewPhase(c, [adopted({ status: 'verifying' })]).kind).toBe('applying');
    // Verified and about to apply itself: still applying, until it waits on a reason.
    expect(reviewPhase(c, [adopted({ status: 'awaiting_approval' })]).kind).toBe('applying');
    expect(
      reviewPhase(c, [
        adopted({
          status: 'awaiting_approval',
          error: { code: 'apply_failed', message: 'main が進みました' },
        }),
      ]).kind,
    ).toBe('apply_wait');
    expect(reviewPhase(c, [adopted({ status: 'failed' })]).kind).toBe('apply_failed');
    expect(reviewPhase(c, [adopted({ status: 'conflict' })]).kind).toBe('apply_failed');
    expect(reviewPhase(c, [adopted({ status: 'applied' })]).kind).toBe('adopted');
    expect(reviewPhase(c, [adopted({ status: 'cancelled' })]).kind).toBe('waiting');
  });

  it('ignores integrations nobody adopted, of other workspaces, or older than the change', () => {
    const c = code();
    expect(adoptionOf(c, [adopted({ preApprovedBy: null })])).toBeNull();
    expect(adoptionOf(c, [adopted({ workspaceIds: ['wsp_2'] })])).toBeNull();
    expect(adoptionOf(c, [adopted({ createdAt: iso(T0 - 1) })])).toBeNull();
    const byTask = output('diff', { taskId: 'tsk_1', review: pending, createdAt: iso(T0) });
    expect(adoptionOf(byTask, [adopted({ workspaceIds: [], taskIds: ['tsk_1'] })])).not.toBeNull();
    const newer = adopted({ createdAt: iso(T0 + 20), status: 'running' });
    expect(adoptionOf(c, [adopted({ status: 'failed' }), newer])).toBe(newer);
  });
});

describe('doneWhenMet', () => {
  it('is met once the work produced its outputs', () => {
    expect(doneWhenMet('working', [])).toBe(false);
    expect(doneWhenMet('done', [])).toBe(true);
    expect(doneWhenMet('review', [])).toBe(true);
    expect(
      doneWhenMet('needs_you', [output('document', { review: { ...pending, state: 'accepted' } })]),
    ).toBe(true);
  });
});

describe('dockedPanelQuery', () => {
  it('docks the panel only where the sidebar, the conversation and the panel all fit', () => {
    expect(dockedPanelQuery(248, 360)).toBe('(min-width: 1088px)');
    expect(dockedPanelQuery(0, 360)).toBe('(min-width: 900px)');
    expect(dockedPanelQuery(0, 520)).toBe('(min-width: 1000px)');
  });
});

describe('helpers', () => {
  it('joins workspace paths in the base style', () => {
    expect(joinPath('C:\\work\\ws', '', 'notes/faq.md')).toBe('C:\\work\\ws\\notes\\faq.md');
    expect(joinPath('/home/a/ws/', 'out', './b.csv')).toBe('/home/a/ws/out/b.csv');
  });

  it('formats sizes and table cells', () => {
    expect(formatSize(12)).toBe('12 B');
    expect(formatSize(2048)).toBe('2 KB');
    expect(formatSize(3 * 1024 * 1024)).toBe('3.0 MB');
    expect(cellText(null)).toBe('');
    expect(cellText(980)).toBe('980');
    expect(cellText({ a: 1 })).toBe('{"a":1}');
  });

  it('knows which files it can show', () => {
    expect(previewKind('a/faq.md', null)).toBe('markdown');
    expect(previewKind('list.csv', 'text/csv')).toBe('csv');
    expect(previewKind('main.ts', null)).toBe('text');
    expect(previewKind('photo.png', 'image/png')).toBeNull();
  });

  it('parses CSV with quotes and CRLF', () => {
    expect(parseCsv('a,b\r\n"x, y","say ""hi"""\n1,2')).toEqual([
      ['a', 'b'],
      ['x, y', 'say "hi"'],
      ['1', '2'],
    ]);
  });
});
