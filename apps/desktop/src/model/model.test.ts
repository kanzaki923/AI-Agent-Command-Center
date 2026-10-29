// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { describeTool, displayPath } from '../lib/tools';
import { T0, iso, message, run, session } from '../test/fixtures';
import { describeApproval } from './approval';
import { buildChatBlocks, summarizeTools } from './chat';
import { parsePatch } from './diff';

describe('chat blocks (§5.2)', () => {
  it('groups consecutive tool calls, attaches results and keeps text order', () => {
    const s = session();
    const r = run(s);
    const msgs = [
      message(s, { content: [{ type: 'text', text: '直して' }], createdAt: iso(T0) }),
      message(s, {
        role: 'assistant',
        runId: r.id,
        createdAt: iso(T0 + 1000),
        content: [
          { type: 'text', text: '確認します。' },
          { type: 'tool_call', toolCallId: 'a', name: 'Read', input: { file_path: '/x/src/a.ts' } },
          { type: 'tool_call', toolCallId: 'b', name: 'Grep', input: { pattern: 'foo' } },
          { type: 'tool_call', toolCallId: 'c', name: 'Read', input: { file_path: '/x/src/b.ts' } },
        ],
      }),
      message(s, {
        role: 'tool',
        createdAt: iso(T0 + 2000),
        content: [{ type: 'tool_result', toolCallId: 'b', output: 'boom', isError: true }],
      }),
      message(s, { role: 'assistant', createdAt: iso(T0 + 3000), content: [{ type: 'text', text: '完了です。' }] }),
    ];
    const blocks = buildChatBlocks({ messages: msgs, approvals: [], streaming: [], runs: [] });
    expect(blocks.map((b) => b.kind)).toEqual(['user', 'assistant', 'tools', 'assistant']);
    const tools = blocks[2]!;
    if (tools.kind !== 'tools') throw new Error('expected tools');
    expect(tools.calls.map((c) => c.id)).toEqual(['a', 'b', 'c']);
    expect(tools.calls[1]).toMatchObject({ isError: true, done: true });
    expect(tools.calls[0]!.done).toBe(false);
    expect(summarizeTools(tools.calls)).toBe('ツール実行 3 件 · 読み取り 2 · 検索 1');
  });

  it('places approvals where they were requested, labels AI-sent messages and appends streams', () => {
    const s = session();
    const r = run(s);
    const a = {
      id: 'apr_1',
      kind: 'tool_use' as const,
      status: 'pending' as const,
      title: 'x',
      detail: null,
      payload: null,
      projectId: null,
      sessionId: s.id,
      runId: r.id,
      taskId: null,
      integrationId: null,
      requestedBy: { kind: 'agent' as const, sessionId: s.id, runId: r.id },
      resolvedBy: null,
      resolutionNote: null,
      createdAt: iso(T0 + 1500),
      resolvedAt: null,
    };
    const fromAgent = message(s, { createdAt: iso(T0), author: { kind: 'agent', sessionId: 'ses_o', runId: 'run_o' } });
    const later = message(s, { role: 'assistant', createdAt: iso(T0 + 2000), content: [{ type: 'text', text: 'ok' }] });
    const blocks = buildChatBlocks({
      messages: [fromAgent, later],
      approvals: [a],
      streaming: [{ messageId: 'm', sessionId: s.id, runId: r.id, text: '途中', reasoning: '', lastIndex: 0, startedAt: 0, partial: false }],
      runs: [{ ...r, status: 'failed', endedAt: iso(T0 + 2500), error: { code: 'x', message: 'エラー' } }],
    });
    expect(blocks.map((b) => b.kind)).toEqual(['user', 'approval', 'assistant', 'run-error', 'streaming']);
    expect(blocks[0]).toMatchObject({ kind: 'user', fromAgent: true });
  });
});

describe('tools', () => {
  it('describes calls in Japanese with concrete targets', () => {
    expect(describeTool('Bash', { command: 'pnpm test' }).activity).toBe('pnpm test を実行中');
    expect(describeTool('Read', { file_path: 'C:\\repo\\src\\auth\\session.ts' }).label).toBe('src/auth/session.ts を読み取り');
    expect(describeTool('Grep', { pattern: 'session' }).activity).toBe('「session」を検索中');
    expect(describeTool('task.wait', {}).activity).toBe('終わるのを待つ');
    const edit = describeTool('Edit', { file_path: '/r/src/a.ts', old_string: 'a\nb', new_string: 'a\nb\nc' });
    expect([edit.additions, edit.deletions]).toEqual([3, 2]);
  });
  it('shortens absolute paths', () => {
    expect(displayPath('/home/me/proj/packages/x/src/y.ts')).toBe('packages/x/src/y.ts');
  });
});

describe('approval view', () => {
  const s = session();
  const r = run(s);
  const base = {
    id: 'apr_x',
    kind: 'tool_use' as const,
    status: 'pending' as const,
    title: 'コマンドの実行',
    detail: null,
    projectId: null,
    sessionId: s.id,
    runId: r.id,
    taskId: null,
    integrationId: null,
    requestedBy: { kind: 'human' as const },
    resolvedBy: null,
    resolutionNote: null,
    createdAt: iso(T0),
    resolvedAt: null,
  };
  it('asks a question and flags dangerous commands', () => {
    const normal = describeApproval({ ...base, payload: { toolName: 'Bash', input: { command: 'pnpm test' } } });
    expect(normal).toMatchObject({ question: 'コマンドの実行を承認しますか？', target: 'pnpm test', risk: 'normal' });
    const push = describeApproval({ ...base, payload: { toolName: 'Bash', input: { command: 'git push origin main' } } });
    expect(push.risk).toBe('high');
    const web = describeApproval({ ...base, payload: { toolName: 'WebFetch', input: { url: 'https://x' } } });
    expect(web).toMatchObject({ question: '外部への送信を承認しますか？', risk: 'high' });
    const file = describeApproval({ ...base, payload: { toolName: 'Write', input: { file_path: '/r/src/a.ts' } } });
    expect(file.question).toBe('ファイルの書き込みを承認しますか？');
  });
});

describe('parsePatch', () => {
  it('numbers lines and counts +/- per file', () => {
    const files = parsePatch(
      [
        'diff --git a/src/a.ts b/src/a.ts',
        'index 1..2 100644',
        '--- a/src/a.ts',
        '+++ b/src/a.ts',
        '@@ -10,3 +10,4 @@ fn',
        ' keep',
        '-old',
        '+new',
        '+added',
        ' tail',
        'diff --git a/b.txt b/b.txt',
        'new file mode 100644',
        '--- /dev/null',
        '+++ b/b.txt',
        '@@ -0,0 +1 @@',
        '+hello',
      ].join('\n'),
    );
    expect(files.map((f) => [f.path, f.additions, f.deletions])).toEqual([
      ['src/a.ts', 2, 1],
      ['b.txt', 1, 0],
    ]);
    const lines = files[0]!.lines;
    expect(lines[1]).toMatchObject({ kind: 'context', oldNo: 10, newNo: 10 });
    expect(lines[2]).toMatchObject({ kind: 'del', oldNo: 11, newNo: null });
    expect(lines[3]).toMatchObject({ kind: 'add', oldNo: null, newNo: 11 });
  });
});

