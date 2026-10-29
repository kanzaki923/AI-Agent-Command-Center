import { beforeEach, describe, expect, it } from 'vitest';
import { EMPTY_FILTERS } from '../model/timeline';
import { filtersFromSearch, filtersToSearch, initialTimelineState, useTimeline } from './timeline';

describe('timeline view state', () => {
  beforeEach(() => {
    localStorage.clear();
    useTimeline.setState({ filters: EMPTY_FILTERS, showAll: false, openRuns: {}, unfolded: {} });
  });

  it('remembers the search and the details switch across restarts (the desktop has no URL bar)', () => {
    useTimeline.getState().setFilters({ text: 'FAQ' });
    useTimeline.getState().setShowAll(true);
    const next = initialTimelineState('');
    expect(next.filters).toEqual({ ...EMPTY_FILTERS, text: 'FAQ' });
    expect(next.showAll).toBe(true);
  });

  it('accepts the old type filters from older callers and ignores them', () => {
    useTimeline.getState().setFilters({ runId: 'run_1', sessionId: null, groups: ['grant', 'approval'] });
    expect(useTimeline.getState().filters).toEqual({ sessionId: null, runId: 'run_1', text: '' });
  });

  it('lets a shared link win over the saved filters, and round-trips through the URL', () => {
    useTimeline.getState().setFilters({ text: 'FAQ' });
    expect(initialTimelineState('?tl.session=ses_1').filters).toEqual({ sessionId: 'ses_1', runId: null, text: '' });
    const search = filtersToSearch('?other=1&tl.types=error', { sessionId: null, runId: 'run_2', text: ' テスト ' });
    expect(search).toContain('other=1');
    expect(search).not.toContain('tl.types');
    expect(filtersFromSearch(search)).toEqual({ sessionId: null, runId: 'run_2', text: 'テスト' });
  });

  it('opens and closes runs, and unfolds trees', () => {
    useTimeline.getState().toggleRun('run_1', false);
    expect(useTimeline.getState().openRuns).toEqual({ run_1: true });
    useTimeline.getState().toggleRun('run_1', true);
    expect(useTimeline.getState().openRuns).toEqual({ run_1: false });
    useTimeline.getState().unfold('ses_1');
    expect(useTimeline.getState().unfolded).toEqual({ ses_1: true });
  });

  it('ignores broken storage', () => {
    localStorage.setItem('acc.timeline', '{not json');
    expect(initialTimelineState('')).toEqual({ filters: EMPTY_FILTERS, showAll: false });
  });
});
