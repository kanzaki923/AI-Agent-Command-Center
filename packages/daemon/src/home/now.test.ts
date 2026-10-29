/**
 * T7 acceptance 1b (spec 20261029 §5.9, §3.7): the "what is it doing now" phrases, per tool,
 * cut at 24 characters, runtime boilerplate rounded to 準備中.
 */
import { describe, expect, it } from 'vitest';
import { describeToolActivity } from '../runtime/tools';
import {
  NOW_MAX_CHARS,
  NOW_PREPARING,
  NOW_THINKING,
  NOW_WRITING,
  clip,
  controlMethodOf,
  nowForActivity,
  nowForTool,
} from './now';

const len = (s: string) => Array.from(s).length;

describe('nowForTool', () => {
  it.each<[string, unknown, string]>([
    ['Edit', { file_path: '/work/docs/faq.md' }, 'faq.md を編集'],
    ['Write', { file_path: 'C:\\work\\notes\\plan.md' }, 'plan.md を編集'],
    ['MultiEdit', {}, 'ファイルを編集'],
    ['Read', { file_path: 'research/pricing.md' }, 'pricing.md を参照'],
    ['NotebookRead', { notebook_path: 'a/b.ipynb' }, 'b.ipynb を参照'],
    ['Bash', { command: 'pnpm test' }, 'pnpm test を実行'],
    ['PowerShell', { command: '  Get-ChildItem  ' }, 'Get-ChildItem を実行'],
    ['Bash', {}, 'コマンドを実行'],
    ['Grep', { pattern: 'TODO' }, '「TODO」を検索'],
    ['Glob', {}, 'ファイルを検索'],
    ['LS', { path: '/work/docs' }, 'docs を確認'],
    ['WebSearch', { query: '競合 価格' }, '「競合 価格」を検索'],
    ['WebFetch', { url: 'https://example.com/pricing?x=1' }, 'example.com を閲覧'],
    ['WebFetch', { url: 'not a url/path' }, 'not a url を閲覧'],
    ['TodoWrite', {}, '作業計画を更新'],
    ['Task', { description: '調べて' }, 'サブエージェントに依頼'],
    ['Skill', {}, 'スキルを使用'],
    ['mcp__browser__open_page', {}, 'open_page を使用'],
    ['SomethingNew', {}, 'SomethingNew を使用'],
  ])('%s %o → %s', (tool, input, phrase) => {
    expect(nowForTool(tool, input)).toBe(phrase);
  });

  it('names Control API calls in every runtime form', () => {
    for (const name of ['session.spawn', 'mcp__acc__session_spawn', 'session__spawn']) {
      expect(controlMethodOf(name)).toBe('session.spawn');
      expect(nowForTool(name, {}, { spawned: 2 })).toBe('2 人に依頼');
    }
    expect(nowForTool('session.spawn', {})).toBe('1 人に依頼');
    expect(nowForTool('session.tree', {})).toBe('状況を確認');
    expect(nowForTool('session.send', {})).toBe('指示を送信');
    expect(nowForTool('artifact.publish', {})).toBe('成果物を公開');
    expect(nowForTool('human.ask', {})).toBe('質問を作成');
    expect(nowForTool('schedule.create', {})).toBe('定期実行を設定');
    expect(nowForTool('integration.run', {})).toBe('変更をまとめる');
    expect(nowForTool('mcp__acc__task_get', {})).toBe('作業を整理');
    expect(controlMethodOf('Read')).toBeNull();
  });

  it('bookkeeping calls keep the previous phrase', () => {
    expect(nowForTool('orchestrator.recordDecision', {})).toBeNull();
    expect(nowForTool('ToolSearch', {})).toBeNull();
  });

  it('cuts to 24 characters and keeps the verb', () => {
    const long = nowForTool('Bash', { command: 'pnpm --filter @acc/daemon test -- --run home' })!;
    expect(len(long)).toBe(NOW_MAX_CHARS);
    expect(long).toBe('pnpm --filter @acc/… を実行');
    const file = nowForTool('Edit', {
      file_path: 'とても長い日本語のファイル名の資料をまとめたもの.md',
    })!;
    expect(len(file)).toBe(NOW_MAX_CHARS);
    expect(file.endsWith('… を編集')).toBe(true);
    const search = nowForTool('WebSearch', { query: 'a'.repeat(100) })!;
    expect(len(search)).toBe(NOW_MAX_CHARS);
    expect(search.endsWith('…」を検索')).toBe(true);
    expect(len(clip('x'.repeat(50)))).toBe(NOW_MAX_CHARS);
    expect(clip('改行\nを  含む')).toBe('改行 を 含む');
  });
});

describe('nowForActivity', () => {
  it('rounds runtime boilerplate to 準備中', () => {
    for (const line of [
      'Claude Code を起動しました',
      'エージェントを起動中',
      '依頼内容を確認中',
      '計画を立てています',
    ]) {
      expect(nowForActivity(line)).toBe(NOW_PREPARING);
    }
  });

  it('reads tool activity lines back into the same phrase as the tool call', () => {
    const cwd = '/work';
    const cases: [string, unknown][] = [
      ['Edit', { file_path: '/work/docs/faq.md' }],
      ['Read', { file_path: '/work/pricing.md' }],
      ['Bash', { command: 'pnpm test' }],
      ['Bash', { command: 'pnpm --filter @acc/daemon test -- --run home --reporter dot' }],
      ['Grep', { pattern: 'TODO' }],
      ['WebSearch', { query: '競合 価格' }],
      ['WebFetch', { url: 'https://example.com/a' }],
      ['LS', { path: '/work/docs' }],
      ['Task', { description: 'x' }],
      ['Edit', {}],
      ['BashOutput', {}],
      ['TodoWrite', {}],
    ];
    for (const [tool, input] of cases) {
      expect(nowForActivity(describeToolActivity(tool, input, cwd)), tool).toBe(
        nowForTool(tool, input),
      );
    }
  });

  it('maps the daemon lines and keeps tool-loop lines silent', () => {
    expect(nowForActivity('応答を生成しています')).toBe(NOW_WRITING);
    expect(nowForActivity('ツールの結果をもとに考えています')).toBe(NOW_THINKING);
    expect(nowForActivity('作業内容をまとめています')).toBe(NOW_WRITING);
    expect(nowForActivity('モデルの応答を待っています（再試行2・529）')).toBe('応答を待機中');
    expect(nowForActivity('変更をコミット中')).toBe('変更を記録中');
    expect(nowForActivity('ツールを実行しています: session.spawn')).toBeNull();
    expect(nowForActivity('ツールを実行中: Foo')).toBeNull();
    expect(nowForActivity(null)).toBeNull();
    expect(nowForActivity('   ')).toBeNull();
    expect(nowForActivity('待機中')).toBe('待機中');
    expect(len(nowForActivity('あ'.repeat(40))!)).toBe(NOW_MAX_CHARS);
  });
});
