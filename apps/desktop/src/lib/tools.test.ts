import { describe, expect, it } from 'vitest';
import { controlMethod, describeTool, toolCategory } from './tools';

describe('controlMethod', () => {
  it('recognises Control API calls however the runtime names them', () => {
    expect(controlMethod('task.create')).toBe('task.create');
    expect(controlMethod('task__create')).toBe('task.create');
    expect(controlMethod('mcp__acc__task__spawnWorker')).toBe('task.spawnWorker');
    expect(controlMethod('Bash')).toBeNull();
    expect(controlMethod('not.a_method')).toBeNull();
    expect(controlMethod('mcp__acc__artifact_publish')).toBe('artifact.publish');
  });

  it('puts waits in their own category', () => {
    expect(toolCategory('task__wait')).toBe('wait');
    expect(toolCategory('integration.wait')).toBe('wait');
    expect(toolCategory('task.create')).toBe('control');
  });
});

describe('describeTool (Control API)', () => {
  it('reads like what happened, verb first', () => {
    expect(describeTool('task.create', { title: '認証のテストを追加する' }).label).toBe(
      '作業を作成: 「認証のテストを追加する」',
    );
    expect(describeTool('task.create', { title: '認証のテストを追加する' }).activity).toBe(
      '作業を作成中: 「認証のテストを追加する」',
    );
    expect(describeTool('integration.create', { taskIds: ['a', 'b'] }).label).toBe(
      '反映の準備（2 件）',
    );
    expect(describeTool('task.wait', { taskIds: ['a', 'b'] }).label).toBe(
      '終わるのを待つ',
    );
    expect(describeTool('orchestrator.recordDecision', { decision: '並列にします' }).label).toBe(
      '判断を記録: 「並列にします」',
    );
    expect(describeTool('budget.allocate', { limitUsd: 2 }).label).toBe('予算を配分 $2.00');
  });

  it('says the calls of the session tree like a chip’s now, with no method names', () => {
    expect(describeTool('session.spawn', { title: '競合 3 社の調査' }).label).toBe('「競合 3 社の調査」に依頼');
    expect(describeTool('mcp__acc__human_ask', { question: '価格を載せる？' }).activity).toBe('質問「価格を載せる？」');
    expect(describeTool('mcp__acc__artifact_publish', { title: 'まとめ' }).label).toBe('「まとめ」を提出');
    const send = describeTool('session.send', { sessionId: 'ses_1' }, { sessionTitle: () => 'FAQ' });
    expect(send).toMatchObject({ label: '「FAQ」に伝える', target: null });
    for (const m of ['task.create', 'integration.run', 'run.cancel', 'grant.create', 'session.create', 'workspace.create', 'events.list']) {
      expect(describeTool(m, {}).label).not.toMatch(/Task|Worker|Run|統合|権限|セッション|worktree|\./);
    }
  });

  it('names the task when the UI knows it', () => {
    const lookup = { taskTitle: (id: string) => (id === 'tsk_1' ? 'README を整える' : undefined) };
    expect(describeTool('task__spawnWorker', { taskId: 'tsk_1' }, lookup).label).toBe(
      'エージェントを起動: 「README を整える」',
    );
    expect(describeTool('task.update', { taskId: 'tsk_1', status: 'review' }, lookup).label).toBe(
      '作業を更新: 「README を整える」 → レビュー待ち',
    );
    expect(describeTool('task.spawnWorker', { taskId: 'tsk_x' }, lookup).label).toBe('エージェントを起動');
  });

  it('describes Claude Code tools that are neither files nor commands', () => {
    expect(describeTool('TodoWrite', { todos: [] }).label).toBe('TODO リストを更新');
    expect(describeTool('Task', { description: 'テストを調べる' }).label).toBe(
      'サブエージェントに依頼: 「テストを調べる」',
    );
  });
});
