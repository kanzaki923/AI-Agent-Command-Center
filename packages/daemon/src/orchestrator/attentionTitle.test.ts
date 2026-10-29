import { describe, expect, it } from 'vitest';
import { attentionTitle } from './workers';

describe('attentionTitle', () => {
  it('says why a child failed, in one line, without repeating its title', () => {
    expect(attentionTitle('failure', '配信リストの整理', null, '顧客リストが見つかりません。\n詳しくは…')).toBe(
      '顧客リストが見つかりません。',
    );
    expect(attentionTitle('failure', 'ビルド', null, 'x'.repeat(200))).toHaveLength(80);
  });

  it('falls back to naming the child when the run gave no reason', () => {
    expect(attentionTitle('failure', 'ビルド', null, null)).toBe('「ビルド」が失敗しました');
    expect(attentionTitle('failure', 'ビルド', null, '  \n ')).toBe('「ビルド」が失敗しました');
    expect(attentionTitle('budget', 'ビルド', null, 'ignored')).toBe('「ビルド」の予算が尽きました');
  });
});
