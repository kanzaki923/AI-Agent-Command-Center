import { beforeEach, describe, expect, it } from 'vitest';
import { EMPTY_FILTERS } from '../model/timeline';
import { initialTimelineState, useTimeline } from './timeline';

describe('timeline filter persistence', () => {
  beforeEach(() => {
    localStorage.clear();
    useTimeline.setState({ filters: EMPTY_FILTERS, groupByRun: true, showAll: false });
  });

  it('remembers filters and view options across restarts (the desktop has no URL bar)', () => {
    useTimeline.getState().setFilters({ groups: ['decision'], actors: ['agent'], text: 'テスト' });
    useTimeline.getState().setShowAll(true);
    useTimeline.getState().setGroupByRun(false);
    const next = initialTimelineState('');
    expect(next.filters).toMatchObject({ groups: ['decision'], actors: ['agent'], text: 'テスト' });
    expect(next.showAll).toBe(true);
    expect(next.groupByRun).toBe(false);
  });

  it('lets a shared link win over the saved filters', () => {
    useTimeline.getState().setFilters({ groups: ['decision'] });
    expect(initialTimelineState('?tl.types=error').filters.groups).toEqual(['error']);
  });

  it('ignores broken storage', () => {
    localStorage.setItem('acc.timeline', '{not json');
    expect(initialTimelineState('')).toEqual({ filters: EMPTY_FILTERS, groupByRun: true, showAll: false });
  });
});
