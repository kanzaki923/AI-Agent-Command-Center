import type { Integration, Task, TaskSnapshot } from '@acc/protocol';
import type { MockReply, MockResponder } from '../llm/mock';
import { methodForToolName, toolNameForMethod } from '../llm/tools';
import type { ChatMessage, ChatRequest } from '../llm/types';
import { ORCHESTRATOR_RESUME_NOTICE, PROJECT_ID_LABEL } from './executor';

/** Offline scripted orchestrator (demo mode and the vertical-slice tests). */
export const MOCK_ORCHESTRATOR_MODEL = 'mock/orchestrator';

/** How long one task.wait / integration.wait call blocks (the mock repeats it on timeout). */
const WAIT_MS = 600_000;

type ToolCall = NonNullable<MockReply['toolCalls']>[number];
type Decide = (decision: string, rationale: string, taskIds?: string[]) => ToolCall[];

interface PastCall {
  method: string;
  input: Record<string, unknown>;
  /** Parsed tool result (JSON), or the raw string. */
  output: unknown;
  error: { code: string; message: string } | null;
}

/**
 * `mock/orchestrator`: a deterministic model that drives the whole Vertical Slice
 * (concept §12.1) through the same Control API tools a real model gets — no shortcuts:
 *
 *   goal → task.create ×2 (independent, acceptance criteria, acc-mock plans for the mock
 *   worker; the test worker's plan runs a command that needs approval) → task.spawnWorker ×2
 *   → task.wait (all) → integration.create → integration.run → integration.wait → report.
 *
 * Every step is decided from the tool results so far (after the last user message), so a
 * failed worker or integration leads to a report instead of the next step. Decisions are
 * recorded with orchestrator.recordDecision when that tool is available.
 */
export const mockOrchestrator: MockResponder = (req, info) => {
  const tools = new Set((req.tools ?? []).map((t) => methodForToolName(t.name)));
  if (!tools.has('task.create') || !tools.has('task.spawnWorker')) {
    return {
      text: 'この会話には Orchestrator の権限がないため、Task の作成や Worker の起動はできません。詳細パネルの「Orchestrator にする」で権限を与えてから、もう一度お願いします。',
    };
  }
  const projectId = projectIdOf(req);
  if (!projectId) {
    return { text: 'どのプロジェクトで作業するかがわかりません。プロジェクトを指定してください。' };
  }
  const decide: Decide = (decision, rationale, taskIds) =>
    tools.has('orchestrator.recordDecision')
      ? [
          call('orchestrator.recordDecision', {
            decision,
            rationale,
            ...(taskIds ? { taskIds } : {}),
          }),
        ]
      : [];

  // Everything since the goal (the last user message), and what happened since the latest
  // turn boundary: the goal, or the daemon's resume notice after a restart.
  const userAt = lastUserIndex(req.messages);
  const calls = pastCalls(req.messages, userAt + 1);
  const resumeAt = lastResumeIndex(req.messages);
  const resumed = resumeAt > userAt;
  const recent = resumed ? pastCalls(req.messages, resumeAt + 1) : calls;
  if (
    calls.length === 0 &&
    alreadyOrchestrated(req.messages) &&
    !/新しい目標/.test(info.lastUserText)
  ) {
    return {
      text: '前回の目標はすでに Task に分解して Worker に任せました。進み具合は Command Mode と Timeline で確認できます。別の目標を任せるときは「新しい目標: …」と送ってください。',
    };
  }
  const last = [...recent].reverse().find((c) => c.method !== 'orchestrator.recordDecision');
  const goal = info.lastUserText.replace(/^新しい目標\s*[:：]\s*/, '').trim() || '依頼された作業';

  if (!last) {
    if (!resumed) return planTasks(projectId, goal, decide);
    // After a restart: read the task states and continue the plan from there.
    return {
      text: 'デーモンの再起動で中断した計画の続きから再開します。まず Task の状態を確認します。',
      toolCalls: [
        ...decide(
          '中断した計画を再開する',
          'デーモンの再起動で前回の Run が中断されました。Task と worktree は残っているため、状態を確かめて続きから進めます。',
          createdTaskIds(calls),
        ),
        call('task.list', { projectId }),
      ],
    };
  }

  const failed = recent.filter((c) => c.method === last.method && c.error);
  switch (last.method) {
    case 'task.list': {
      if (last.error) return report(`Task の状況を確認できませんでした: ${last.error.message}`);
      const ids = createdTaskIds(calls);
      const mine = ((last.output as { items?: Task[] } | null)?.items ?? []).filter((t) =>
        ids.includes(t.id),
      );
      if (mine.length === 0) return report('再開できる Task が見つかりませんでした。');
      const restart = mine.filter((t) => t.status === 'ready');
      if (restart.length === 0) {
        return {
          text: 'Task の状態を確認しました。終わるまで見守ります。',
          toolCalls: [waitForTasks(ids)],
        };
      }
      return {
        text: `中断された ${restart.length} 件の Task を、同じ worktree とブランチから再開します。`,
        toolCalls: [
          ...decide(
            `${restart.length}件の Task を再開する`,
            'Worker の作業がデーモンの再起動で中断されました。コミット済みの変更とブランチは残っているため、同じ Worker セッションで続きから進めます。',
            restart.map((t) => t.id),
          ),
          ...restart.map((t) =>
            t.assigneeSessionId
              ? call('task.retry', { taskId: t.id })
              : call('task.spawnWorker', { taskId: t.id }),
          ),
        ],
      };
    }
    case 'task.create': {
      if (failed.length > 0)
        return report(`Task を作成できませんでした: ${failed[0]!.error!.message}`);
      const ids = createdTaskIds(calls);
      return {
        text: `${ids.length}件の Task を作成しました。それぞれに Worker を起動します。`,
        toolCalls: [
          ...decide(
            `${ids.length}人の Worker を並列で起動する`,
            'Task 同士は別々のファイルを扱い依存関係がないため、同時に進めても衝突しません。',
            ids,
          ),
          ...ids.map((taskId) => call('task.spawnWorker', { taskId })),
        ],
      };
    }
    case 'task.retry':
    case 'task.spawnWorker': {
      const startFailed = recent.filter(
        (c) => (c.method === 'task.spawnWorker' || c.method === 'task.retry') && c.error,
      );
      if (startFailed.length > 0) {
        return report(
          `Worker を起動できませんでした: ${startFailed.map((c) => c.error!.message).join(' / ')}`,
        );
      }
      return {
        text: 'Worker が作業を始めました。すべての Task が終わるまで見守ります。',
        toolCalls: [waitForTasks(createdTaskIds(calls))],
      };
    }
    case 'task.wait': {
      if (last.error) return report(`Task の状況を確認できませんでした: ${last.error.message}`);
      const out = last.output as { tasks?: TaskSnapshot[]; timedOut?: boolean };
      const tasks = out.tasks ?? [];
      if (out.timedOut) {
        const waiting = tasks.reduce((n, t) => n + t.pendingApprovals, 0);
        return {
          text:
            waiting > 0
              ? `承認待ちの操作が ${waiting} 件あります。承認されるまで待ちます。`
              : 'まだ作業中の Task があります。引き続き待ちます。',
          toolCalls: [waitForTasks(tasks.map((t) => t.id))],
        };
      }
      const notReview = tasks.filter((t) => t.status !== 'review');
      if (notReview.length > 0) {
        const lines = notReview.map(
          (t) =>
            `- Task ${t.id}「${t.title}」: ${statusJa(t.status)}${t.resultSummary ? `（${oneLine(t.resultSummary)}）` : ''}`,
        );
        return {
          text: [
            `${notReview.length}件の Task が完了しなかったため、統合は見送りました。`,
            '',
            ...lines,
            '',
            '対応案: 失敗の理由を確認し、必要なら Task の内容を直して Worker をもう一度起動してください（同じ worktree とブランチから再開できます）。',
          ].join('\n'),
          toolCalls: decide(
            '統合を見送る',
            `完了しなかった Task があります（${notReview.map((t) => `${t.title}: ${t.status}`).join('、')}）。一部だけを統合すると目標を満たさないため、人間の判断を待ちます。`,
            notReview.map((t) => t.id),
          ),
        };
      }
      const ids = tasks.map((t) => t.id);
      // Resumed after a restart with an integration already created: run it again.
      const existing = createdIntegrationId(calls);
      return {
        text: 'すべての Task がレビュー待ちになりました。変更を統合ブランチにまとめて、テストで検証します。',
        toolCalls: [
          ...decide(
            `${ids.length}件の Task を統合する`,
            'すべての Worker が完了し、差分が記録されました。統合ブランチでまとめてテストし、人間のレビューに回します。',
            ids,
          ),
          existing
            ? call('integration.run', { integrationId: existing })
            : call('integration.create', { projectId, taskIds: ids }),
        ],
      };
    }
    case 'integration.resolveWithAgent': {
      if (last.error) {
        return report(`Integrator を起動できませんでした: ${last.error.message}`);
      }
      const integ = (last.output as { integration: Integration }).integration;
      return {
        text: 'Integrator がコンフリクトを解消しています。終わると統合が再開されてテストが走るので、待ちます。',
        toolCalls: [call('integration.wait', { integrationId: integ.id, timeoutMs: WAIT_MS })],
      };
    }
    case 'integration.create': {
      if (last.error) return report(`統合候補を作成できませんでした: ${last.error.message}`);
      const integ = last.output as Integration;
      return {
        text: '統合ブランチを作りました。マージとテストを実行します。',
        toolCalls: [call('integration.run', { integrationId: integ.id })],
      };
    }
    case 'integration.run': {
      if (last.error) return report(`統合を実行できませんでした: ${last.error.message}`);
      const integ = last.output as Integration;
      return {
        toolCalls: [call('integration.wait', { integrationId: integ.id, timeoutMs: WAIT_MS })],
      };
    }
    case 'integration.wait': {
      if (last.error) return report(`統合の状況を確認できませんでした: ${last.error.message}`);
      const out = last.output as { integration: Integration; timedOut: boolean };
      const integ = out.integration;
      if (out.timedOut) {
        return {
          text: '統合の検証がまだ終わっていません。引き続き待ちます。',
          toolCalls: [call('integration.wait', { integrationId: integ.id, timeoutMs: WAIT_MS })],
        };
      }
      const triedResolve = calls.some(
        (c) => c.method === 'integration.resolveWithAgent' && c.input.integrationId === integ.id,
      );
      if (
        integ.status === 'conflict' &&
        !triedResolve &&
        tools.has('integration.resolveWithAgent')
      ) {
        const files = integ.steps.flatMap((s) => (s.kind === 'merge' ? s.conflictFiles : []));
        return {
          text: `マージでコンフリクトが発生しました（${files.join(', ')}）。Integrator に解消を任せます。`,
          toolCalls: [
            ...decide(
              'Integrator にコンフリクトの解消を任せる',
              `統合ブランチへのマージが ${files.join(', ')} でコンフリクトしました。両方の Task の目標を渡して解消させ、テストで確かめます。解消できなければ人間に相談します。`,
              integ.taskIds,
            ),
            call('integration.resolveWithAgent', { integrationId: integ.id }),
          ],
        };
      }
      if (integ.status !== 'awaiting_approval') {
        const next =
          integ.status === 'conflict'
            ? '対応案: Integrator でも解消できませんでした。統合の手順ログでコンフリクトしたファイルを確認し、どちらの変更を残すか判断してください（各 worktree とブランチは残っています）。'
            : integ.error?.code === 'tests_failed'
              ? `対応案: テストの失敗を確認してください。原因の Task は task.retry（integrationId: ${integ.id}）で、失敗したテストの出力つきで元の Worker に差し戻せます。直したら統合をもう一度実行します。`
              : '対応案: 統合の手順ログを確認し、原因になった Task を直してから、もう一度統合を実行してください。各 worktree とブランチは残っています。';
        return {
          text: [
            `統合候補 ${integ.id} は「${statusJa(integ.status)}」で止まりました。`,
            ...(integ.error ? [`理由: ${integ.error.message}`] : []),
            '',
            next,
          ].join('\n'),
          toolCalls: decide(
            '統合候補をレビューに回さない',
            `統合が ${integ.status} で終わりました${integ.error ? `（${integ.error.message}）` : ''}。`,
            integ.taskIds,
          ),
        };
      }
      return finalSummary(integ, calls, decide);
    }
    default:
      return {
        text: '作業の流れを判断できませんでした。状況を確認してから、もう一度指示してください。',
      };
  }
};

// ---------------------------------------------------------------------------
// Plans
// ---------------------------------------------------------------------------

function planTasks(projectId: string, goal: string, decide: Decide): MockReply {
  const auth = /認証|ログイン|auth|login/i.test(goal);
  const topic = auth ? 'auth' : 'feature';
  const label = auth ? '認証' : 'この機能';
  const docPath = `docs/${topic}.md`;
  const testPath = `test/${topic}.test.js`;

  const docPlan = {
    steps: [
      { type: 'say', text: `${label}まわりの現状を確認して、ドキュメントの構成を決めます。` },
      { type: 'write', path: docPath, content: docContent(label, goal) },
      {
        type: 'append',
        path: 'README.md',
        content: `\n- [${label}まわりのドキュメント](${docPath})\n`,
      },
      { type: 'check', path: docPath, contains: '## 使い方' },
    ],
    summary: `${docPath} を書き、README.md からリンクしました。`,
  };
  // "…README…" in the goal: the test task documents how to run the tests in README.md too,
  // so both tasks append to the same place and their merge conflicts (an integrator fixes it).
  const sharedReadme = /readme/i.test(goal);
  const testPlan = {
    steps: [
      { type: 'say', text: `${label}まわりの振る舞いをテストで確かめられるようにします。` },
      { type: 'write', path: testPath, content: testContent(label) },
      ...(sharedReadme
        ? [
            {
              type: 'append',
              path: 'README.md',
              content: `\n- テストの実行方法: \`node --test\`\n`,
            },
          ]
        : []),
      {
        type: 'run',
        command: 'node',
        args: ['--test', testPath],
        title: '追加したテストを実行する',
        onReject: 'fail',
      },
    ],
    summary: `${testPath} を追加し、テストが通ることを確認しました。`,
  };
  const task = (title: string, body: string[], criteria: string[], plan: unknown) => ({
    projectId,
    title,
    description: [
      `目標「${goal}」のうち、次の作業を担当します。`,
      '',
      ...body,
      '',
      '```acc-mock',
      JSON.stringify(plan, null, 2),
      '```',
    ].join('\n'),
    acceptanceCriteria: criteria,
  });
  return {
    text: sharedReadme
      ? `「${goal}」を、並列で進められる2つの Task に分解します。どちらも README.md に追記するため、統合でコンフリクトしたら Integrator に解消を任せます。`
      : `「${goal}」を、並列で進められる2つの Task に分解します。ドキュメントとテストは別のファイルを扱うので、同時に進めても衝突しません。`,
    toolCalls: [
      ...decide(
        '目標を2つの独立した Task に分解する',
        sharedReadme
          ? `ドキュメント（${docPath}）とテスト（${testPath}）は依存関係がなく並列にできます。README.md は両方が追記するので、統合時のコンフリクトは Integrator が解消します。`
          : `ドキュメント（${docPath}、README.md）とテスト（${testPath}）は触るファイルが重ならず、依存関係もないため並列にできます。`,
      ),
      call(
        'task.create',
        task(
          `${label}まわりのドキュメントを整備する`,
          [`- ${docPath} に概要・使い方・注意点をまとめる`, '- README.md からリンクする'],
          [
            `${docPath} に概要・使い方・注意点が書かれている`,
            `README.md から ${docPath} へのリンクがある`,
          ],
          docPlan,
        ),
      ),
      call(
        'task.create',
        task(
          `${label}まわりのテストを整備する`,
          [
            `- ${testPath} にテストを追加する`,
            ...(sharedReadme ? ['- README.md にテストの実行方法を書く'] : []),
            '- テストを実行して通ることを確かめる',
          ],
          [
            `${testPath} がある`,
            ...(sharedReadme ? ['README.md にテストの実行方法がある'] : []),
            'プロジェクトのテストコマンドが成功する',
          ],
          testPlan,
        ),
      ),
    ],
  };
}

function docContent(label: string, goal: string): string {
  return [
    `# ${label}まわりのドキュメント`,
    '',
    '## 概要',
    '',
    `${label}の仕組みと、使うときに知っておきたいことをまとめます（依頼: ${goal}）。`,
    '',
    '## 使い方',
    '',
    '1. トークンを発行する',
    '2. リクエストのヘッダーに付けて送る',
    '3. 期限が切れたら再発行する',
    '',
    '## 注意点',
    '',
    '- トークンはログやリポジトリに残さない',
    '- 失敗時のメッセージから内部情報がわからないようにする',
    '',
  ].join('\n');
}

function testContent(label: string): string {
  return [
    "const test = require('node:test');",
    "const assert = require('node:assert/strict');",
    '',
    '// Token format used in the docs: tok_ + at least 8 lowercase letters/digits.',
    'const isToken = (s) => typeof s === "string" && /^tok_[a-z0-9]{8,}$/.test(s);',
    '',
    `test('${label}: 正しい形式のトークンを受け付ける', () => {`,
    "  assert.equal(isToken('tok_abcdef12'), true);",
    '});',
    '',
    `test('${label}: 形式の違うトークンを拒否する', () => {`,
    "  assert.equal(isToken('invalid'), false);",
    '  assert.equal(isToken(undefined), false);',
    '});',
    '',
  ].join('\n');
}

function finalSummary(integ: Integration, calls: PastCall[], decide: Decide): MockReply {
  const verify = integ.steps.find((s) => s.kind === 'verify');
  const testResult =
    verify?.status === 'succeeded'
      ? '成功'
      : verify?.status === 'skipped'
        ? '省略（テストコマンド未設定）'
        : '不明';
  const waits = calls.filter((c) => c.method === 'task.wait' && !c.error);
  const snapshots = (
    (waits.at(-1)?.output as { tasks?: TaskSnapshot[] } | undefined)?.tasks ?? []
  ).filter((t) => integ.taskIds.includes(t.id));
  const taskLines = snapshots.map((t) => {
    const diff = t.diff
      ? `、${t.diff.files} ファイル +${t.diff.additions} −${t.diff.deletions}`
      : '';
    return `- Task ${t.id}「${t.title}」（レビュー待ち${diff}）`;
  });
  const n = integ.taskIds.length;
  const fixes = integ.steps.filter((s) => s.kind === 'fix' && s.status === 'succeeded');
  return {
    text: [
      `${n}件のTaskが完了し、統合候補ができました。テスト: ${testResult}。レビューして承認してください。`,
      '',
      ...taskLines,
      `- 統合候補 ${integ.id}: ${integ.branch ?? ''} → ${integ.targetRef ?? ''}`,
      ...fixes.map(
        (s) =>
          `- コンフリクト（${s.conflictFiles.join(', ')}）は Integrator が解消しました。解消した内容も差分で確認してください`,
      ),
      '',
      '承認すると、統合ブランチが反映先ブランチに早送りで反映されます（承認は人間だけが行えます）。',
    ].join('\n'),
    toolCalls: decide(
      '統合候補を人間のレビューに回す',
      `すべての変更をマージでき、統合後のテストが${testResult}でした。反映には人間の承認が必要です。`,
      integ.taskIds,
    ),
  };
}

// ---------------------------------------------------------------------------
// Conversation parsing
// ---------------------------------------------------------------------------

function call(method: string, input: Record<string, unknown>): ToolCall {
  return { name: toolNameForMethod(method), input };
}

function waitForTasks(taskIds: string[]) {
  return call('task.wait', { taskIds, mode: 'all', timeoutMs: WAIT_MS });
}

function report(text: string): MockReply {
  return { text: `${text}\n\n状況を確認してから、もう一度指示してください。` };
}

function projectIdOf(req: ChatRequest): string | null {
  const system = req.messages.find((m) => m.role === 'system');
  const content = system?.role === 'system' ? system.content : '';
  const re = new RegExp(`${PROJECT_ID_LABEL}\\s*(prj_[0-9a-z]{26})`);
  return re.exec(content)?.[1] ?? null;
}

function lastUserIndex(messages: ChatMessage[]): number {
  for (let i = messages.length - 1; i >= 0; i--) if (messages[i]!.role === 'user') return i;
  return -1;
}

/** Index of the daemon's latest "resume after restart" notice (a system message), or -1. */
function lastResumeIndex(messages: ChatMessage[]): number {
  for (let i = messages.length - 1; i > 0; i--) {
    const m = messages[i]!;
    if (m.role === 'system' && m.content.startsWith(ORCHESTRATOR_RESUME_NOTICE)) return i;
  }
  return -1;
}

/** Tool calls made from message `start` on, with their results, in order. */
function pastCalls(messages: ChatMessage[], start: number): PastCall[] {
  const out: PastCall[] = [];
  const slice = messages.slice(start);
  for (const [i, m] of slice.entries()) {
    if (m.role !== 'assistant') continue;
    // Results are the tool messages right after this assistant message. Matched within
    // that window: tool call ids may repeat across runs (e.g. after a daemon restart).
    const results = new Map<string, string>();
    for (const r of slice.slice(i + 1)) {
      if (r.role !== 'tool') break;
      results.set(r.toolCallId, r.content);
    }
    for (const tc of m.toolCalls ?? []) {
      const raw = results.get(tc.id);
      const output = parse(raw);
      const err = (output as { error?: { code?: unknown; message?: unknown } } | null)?.error;
      out.push({
        method: methodForToolName(tc.name),
        input: (parse(tc.arguments) as Record<string, unknown> | null) ?? {},
        output,
        error:
          err && typeof err === 'object'
            ? {
                code: typeof err.code === 'string' ? err.code : 'error',
                message: typeof err.message === 'string' ? err.message : '',
              }
            : null,
      });
    }
  }
  return out;
}

/** Whether an earlier user turn already started workers (follow-up messages do not re-plan). */
function alreadyOrchestrated(messages: ChatMessage[]): boolean {
  const end = lastUserIndex(messages);
  return messages
    .slice(0, Math.max(0, end))
    .some(
      (m) =>
        m.role === 'assistant' &&
        (m.toolCalls ?? []).some((tc) => methodForToolName(tc.name) === 'task.spawnWorker'),
    );
}

function createdTaskIds(calls: PastCall[]): string[] {
  return calls
    .filter((c) => c.method === 'task.create' && !c.error)
    .map((c) => (c.output as { id?: unknown } | null)?.id)
    .filter((id): id is string => typeof id === 'string');
}

function createdIntegrationId(calls: PastCall[]): string | null {
  const c = calls.filter((x) => x.method === 'integration.create' && !x.error).at(-1);
  const id = (c?.output as { id?: unknown } | null | undefined)?.id;
  return typeof id === 'string' ? id : null;
}

function parse(raw: string | undefined): unknown {
  if (raw === undefined) return null;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return raw;
  }
}

function oneLine(s: string): string {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > 120 ? `${t.slice(0, 119)}…` : t;
}

const STATUS_JA: Record<string, string> = {
  pending: '待機中',
  ready: '着手可能',
  running: '実行中',
  review: 'レビュー待ち',
  done: '完了',
  failed: '失敗',
  cancelled: 'キャンセル',
  blocked: 'ブロック中',
  awaiting_approval: '承認待ち',
  conflict: 'コンフリクト',
  applied: '反映済み',
  rejected: '却下',
  verifying: '検証中',
};

function statusJa(s: string): string {
  return STATUS_JA[s] ?? s;
}
