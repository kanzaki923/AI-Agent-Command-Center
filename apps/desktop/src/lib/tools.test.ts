import { describe, expect, it } from 'vitest';
import { controlMethod, describeTool, toolCategory } from './tools';

describe('controlMethod', () => {
  it('recognises Control API calls however the runtime names them', () => {
    expect(controlMethod('task.create')).toBe('task.create');
    expect(controlMethod('task__create')).toBe('task.create');
    expect(controlMethod('mcp__acc__task__spawnWorker')).toBe('task.spawnWorker');
    expect(controlMethod('Bash')).toBeNull();
    expect(controlMethod('not.a_method')).toBeNull();
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
      'Task を作成: 「認証のテストを追加する」',
    );
    expect(describeTool('task.create', { title: '認証のテストを追加する' }).activity).toBe(
      'Task を作成中: 「認証のテストを追加する」',
    );
    expect(describeTool('integration.create', { taskIds: ['a', 'b'] }).label).toBe(
      '統合候補を作成（2 件の Task）',
    );
    expect(describeTool('task.wait', { taskIds: ['a', 'b'] }).label).toBe(
      'Worker の完了を待機（2 件）',
    );
    expect(describeTool('orchestrator.recordDecision', { decision: '並列にします' }).label).toBe(
      '判断を記録: 「並列にします」',
    );
    expect(describeTool('budget.allocate', { limitUsd: 2 }).label).toBe('予算を配分 $2.00');
  });

  it('names the task when the UI knows it', () => {
    const lookup = { taskTitle: (id: string) => (id === 'tsk_1' ? 'README を整える' : undefined) };
    expect(describeTool('task__spawnWorker', { taskId: 'tsk_1' }, lookup).label).toBe(
      'Worker を起動: 「README を整える」',
    );
    expect(describeTool('task.update', { taskId: 'tsk_1', status: 'review' }, lookup).label).toBe(
      'Task を更新: 「README を整える」 → レビュー待ち',
    );
    expect(describeTool('task.spawnWorker', { taskId: 'tsk_x' }, lookup).label).toBe('Worker を起動');
  });

  it('describes Claude Code tools that are neither files nor commands', () => {
    expect(describeTool('TodoWrite', { todos: [] }).label).toBe('TODO リストを更新');
    expect(describeTool('Task', { description: 'テストを調べる' }).label).toBe(
      'サブエージェントに依頼: 「テストを調べる」',
    );
  });
});
