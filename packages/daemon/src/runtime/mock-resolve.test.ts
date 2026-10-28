import { describe, expect, it } from 'vitest';
import { MockPlan, resolveConflictMarkers } from './mock/plan';

const CONFLICT = [
  'top\n',
  '<<<<<<< HEAD\n',
  'ours 1\n',
  'ours 2\n',
  '=======\n',
  'theirs\n',
  '>>>>>>> acc/ui-1234\n',
  'middle\r\n',
  '<<<<<<< HEAD\r\n',
  'o\r\n',
  '||||||| base\r\n',
  'b\r\n',
  '=======\r\n',
  't\r\n',
  '>>>>>>> acc/ui-1234\r\n',
  'end',
].join('');

describe('resolveConflictMarkers', () => {
  it('keeps both sides (ours first), drops the diff3 base, keeps line endings', () => {
    const r = resolveConflictMarkers(CONFLICT, 'ours+theirs');
    expect(r.hunks).toBe(2);
    expect(r.text).toBe('top\nours 1\nours 2\ntheirs\nmiddle\r\no\r\nt\r\nend');
  });

  it('keeps one side', () => {
    expect(resolveConflictMarkers(CONFLICT, 'ours').text).toBe(
      'top\nours 1\nours 2\nmiddle\r\no\r\nend',
    );
    expect(resolveConflictMarkers(CONFLICT, 'theirs').text).toBe('top\ntheirs\nmiddle\r\nt\r\nend');
  });

  it('leaves text without markers alone (a lone ======= line is content)', () => {
    const text = 'title\n=======\nbody\n';
    expect(resolveConflictMarkers(text, 'ours+theirs')).toEqual({ text, hunks: 0 });
  });

  it('is available as an acc-mock plan step', () => {
    const plan = MockPlan.parse({ steps: [{ type: 'resolve' }] });
    expect(plan.steps[0]).toEqual({ type: 'resolve', strategy: 'ours+theirs' });
  });
});
