/**
 * UI audit scene (dev only): "a normal day" of a general user, built through the REAL Core
 * Daemon and Control API with mock models and the mock runtime only (no LLM endpoint, no cost).
 *
 *   - plain chats without a project (a question, a writing request, one still streaming)
 *   - a project without a repository holding an everyday chat (weekly report)
 *   - a non-coding goal: a chat that first gives advice, is then granted orchestration with a
 *     small budget, and spawns 4 workers itself (one running, one done, one asking the human,
 *     one failed) while it keeps waiting for them — its budget ends up close to the limit
 *   - a coding goal run by the built-in `mock/orchestrator` up to an integration waiting for
 *     review, plus a human-started agent that keeps running
 *
 * Every row the UI shows comes from daemon state; the orchestrators really call the Control
 * API tools (task.create / task.spawnWorker / task.wait ...) under their grants. Repositories
 * live inside ACC_HOME, so removing ACC_HOME removes everything.
 *
 *   ACC_HOME=<dir> ACC_PORT=<port> pnpm --filter @acc/desktop exec tsx scripts/audit-scene.ts [--hold]
 *
 * --hold   start the daemon, print "daemon ready", and build the scene only after a line
 *          arrives on stdin (so a UI can first be captured empty). e2e/audit.js drives this.
 * Prints "scene ready" when everything is in place; running parts keep running ~10 minutes.
 */
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import type { Actor, MethodName, ParamsInput, Result } from '@acc/protocol';

// node:sqlite prints an ExperimentalWarning on load; expected.
const originalEmitWarning = process.emitWarning.bind(process);
process.emitWarning = (warning: string | Error, ...rest: unknown[]) => {
  const msg = typeof warning === 'string' ? warning : warning.message;
  if (msg.includes('SQLite is an experimental feature')) return;
  (originalEmitWarning as (...a: unknown[]) => void)(warning, ...rest);
};

const HUMAN: Actor = { kind: 'human', client: 'audit-scene' };
const home = process.env.ACC_HOME || mkdtempSync(join(tmpdir(), 'acc-audit-'));
process.env.ACC_HOME = home;
process.env.ACC_PORT ??= '47898';
// Never reach a real LLM endpoint from the scene.
delete process.env.ACC_LITELLM_BASE_URL;
delete process.env.ACC_LITELLM_API_KEY;

/** Longest mock sleep (10 min): "still running" for the whole capture. */
const LONG = 600_000;

const fence = (plan: unknown) => ['```acc-mock', JSON.stringify(plan, null, 2), '```'].join('\n');

/** A git repository under ACC_HOME/repos with a neutral identity and one commit. */
function makeRepo(name: string, files: Record<string, string>): string {
  const dir = join(home, 'repos', name);
  mkdirSync(dir, { recursive: true });
  const git = (...args: string[]) => {
    const r = spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  };
  git('init', '-q', '-b', 'main');
  for (const [k, v] of Object.entries({
    'core.autocrlf': 'false',
    'commit.gpgsign': 'false',
    'user.name': 'Scene',
    'user.email': 'scene@example.com',
  })) {
    git('config', k, v);
  }
  for (const [file, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, file)), { recursive: true });
    writeFileSync(join(dir, file), content);
  }
  git('add', '-A');
  git('commit', '-q', '-m', 'Initial commit');
  return dir;
}

// ------------------------------------------------------------------ canned everyday answers

const ANSWERS: { match: RegExp; text: string }[] = [
  {
    match: /Excel|重複/,
    text: [
      'A 列が同じ行を 1 行だけ残すには、**重複の削除** を使うのがいちばん早いです。',
      '',
      '1. 表のどこかのセルを選ぶ',
      '2. **データ** タブ → **重複の削除**',
      '3. 「列 A」だけにチェックを入れて **OK**',
      '',
      '元のデータを残したいときは、先にシートをコピーしておくか、`=UNIQUE(A2:D200)` で別の場所に重複なしの一覧を作る方法もあります。',
    ].join('\n'),
  },
  {
    match: /お詫び|遅れ/,
    text: [
      '件名：納品日変更のお詫び（11 月 5 日 → 11 月 7 日）',
      '',
      '株式会社〇〇　ご担当者様',
      '',
      'いつもお世話になっております。',
      'ご依頼いただいております資料一式につきまして、弊社の確認工程に想定以上の時間を要しており、納品日を **11 月 7 日（金）** へ変更させていただきたく、ご連絡いたしました。',
      '',
      'ご予定に影響が出ないよう、先行して 11 月 5 日に途中版をお送りすることも可能です。',
      'ご迷惑をおかけし、誠に申し訳ございません。何卒よろしくお願い申し上げます。',
    ].join('\n'),
  },
  {
    match: /週次|進捗/,
    text: [
      '- 新製品ローンチ：プレスリリース案が完成、FAQ は価格の扱いを確認中',
      '- acme-web：ログインまわりのドキュメントとテストを統合、レビュー待ち',
      '- 来週：告知メールの配信リストを整える（顧客リストの所在を確認）',
    ].join('\n'),
  },
  {
    match: /ローンチ|何から/,
    text: [
      '発売まで 3 週間なら、次の順に進めるのがおすすめです。',
      '',
      '1. **競合の把握**：価格と訴求点を 1 枚にまとめる（以降の文章の土台になる）',
      '2. **プレスリリース**：発売日・価格・3 つの特長を確定させる',
      '3. **FAQ**：問い合わせが多そうな 10 問を先に用意',
      '4. **告知メール**：既存顧客向け、発売日の朝に配信',
      '',
      '2〜4 は 1 の結果を待たずに下書きを並行して進められます。',
    ].join('\n'),
  },
];

const BLOG = [
  '# リモートワークを 1 年続けてわかったこと',
  '',
  '去年の秋から、チームの全員がリモートで働くようになりました。最初の 1 か月は「思ったより快適だ」という声ばかりでしたが、3 か月目あたりから、会話の量が目に見えて減っていきました。',
  '',
  '## 1. 雑談は自然には生まれない',
  '',
  'オフィスでは、コーヒーを淹れに行くだけで誰かと話していました。リモートではそれがありません。私たちは毎朝 10 分だけ、議題を決めない時間をつくりました。最初はぎこちなかったのですが、いまでは一日のなかでいちばん情報が集まる時間になっています。',
  '',
  '## 2. 書いて残すと、決めるのが速くなる',
  '',
  '会議で決めたことをその場で 3 行に書き、チャンネルに貼る。それだけで「あれってどうなったんだっけ」という確認がほとんどなくなりました。書くのは面倒ですが、聞き返される手間に比べればずっと安いものです。',
  '',
  '## 3. 終わりの時間を決める',
  '',
  '家で働いていると、仕事の終わりがあいまいになります。私は 18 時にノート PC を閉じて、別の部屋に置くことにしました。物理的に離すのが、いちばん効きました。',
  '',
  '## 4. 1 年たって',
  '',
  'リモートワークは、放っておいてもうまくいく仕組みではありません。雑談の時間、書いて残す習慣、終わりの合図。小さな工夫を積み重ねることで、ようやくオフィスにいたころと同じくらい、あるいはそれ以上に、チームで働けている実感があります。',
].join('\n');

async function main(): Promise<void> {
  // Imported after the warning filter is installed (like the daemon's own main.ts).
  const { createLogger, parseLogLevel } = await import('../../../packages/daemon/src/core/log');
  const { startDaemon } = await import('../../../packages/daemon/src/daemon');
  const { DEMO_FILES } = await import('../../../packages/daemon/src/orchestrator/demo');
  const { toolNameForMethod } = await import('../../../packages/daemon/src/llm/tools');
  const daemon = await startDaemon({
    home,
    log: createLogger(parseLogLevel(process.env.ACC_LOG_LEVEL ?? 'warn')),
  });
  const call = <M extends MethodName>(
    m: M,
    p: ParamsInput<M>,
    actor: Actor = HUMAN,
  ): Promise<Result<M>> => daemon.call(actor, m, p as never);
  const until = async <T>(
    what: string,
    fn: () => Promise<T | null | undefined | false>,
    ms = 60_000,
  ): Promise<T> => {
    const end = Date.now() + ms;
    for (;;) {
      const v = await fn();
      if (v) return v;
      if (Date.now() > end) throw new Error(`audit-scene: timed out waiting for ${what}`);
      await new Promise((r) => setTimeout(r, 150));
    }
  };
  const stop = () => {
    void daemon.close().finally(() => process.exit(0));
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  console.log(`ACC_HOME=${home}`);
  console.log(`daemon ${daemon.url}`);
  console.log('daemon ready');

  if (process.argv.includes('--hold')) {
    const rl = createInterface({ input: process.stdin });
    await new Promise<void>((res) => rl.once('line', () => res()));
    rl.close();
  }

  // ---------------------------------------------------------------- LLM connection
  // Look like a user with a connected LiteLLM Proxy (not demo mode, so costs are shown): a
  // loopback stub that only lists model names. Every run below uses mock models / the mock
  // runtime; anything else sent to the stub is refused.
  const stub = createServer((req, res) => {
    if (req.method === 'GET' && (req.url ?? '').endsWith('/models')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          data: [{ id: 'claude-sonnet-4-5' }, { id: 'claude-haiku-4-5' }, { id: 'gpt-4o-mini' }],
        }),
      );
      return;
    }
    res.writeHead(503, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'audit-scene stub: no real LLM calls' } }));
  });
  await new Promise<void>((res) => stub.listen(0, '127.0.0.1', res));
  daemon.ctx.onClose(() => void stub.close());
  const stubPort = (stub.address() as { port: number }).port;
  await call('settings.update', { litellm: { baseUrl: `http://127.0.0.1:${stubPort}/v1` } });

  // ---------------------------------------------------------------- mock models
  const mock = daemon.ctx.service('llm').mock;
  mock.define(
    'mock/assistant',
    (_req, info) => ({
      text:
        ANSWERS.find((a) => a.match.test(info.lastUserText))?.text ??
        'わかりました。もう少し詳しく教えてください。',
      usage: { costUsd: 0.004 },
    }),
    { label: 'モック（アシスタント）', chunkDelayMs: 5 },
  );
  // A long answer streamed slowly: "still writing" for ~5 minutes.
  mock.define('mock/writer', () => ({ text: BLOG, usage: { costUsd: 0.012 } }), {
    label: 'モック（ライター）',
    chunkDelayMs: 450,
    chunkSize: 3,
  });

  // ---------------------------------------------------------------- projects
  const launchRepo = makeRepo('product-launch', {
    'README.md': [
      '# Komorebi ノート ローンチ準備',
      '',
      '11 月 20 日に発売する「Komorebi ノート」（家族で使う予定共有ノートアプリ）の準備資料です。',
      '',
    ].join('\n'),
    'docs/product.md': [
      '# 製品概要',
      '',
      '- 名前: Komorebi ノート',
      '- 発売日: 11 月 20 日',
      '- 価格: 月額 980 円（10/28 時点で仮）',
      '- 特長: 家族の予定をひとつに / 買い物リストの共有 / 子どもの行事の通知',
      '',
    ].join('\n'),
    'notes/meeting-1028.md': [
      '# 10/28 定例メモ',
      '',
      '- 価格は仮。正式決定は 11/4 の経営会議',
      '- 告知メールは既存顧客（約 1,200 名）向け',
      '',
    ].join('\n'),
  });
  const launch = await call('project.create', {
    name: '新製品ローンチ',
    description: 'Komorebi ノートの発売準備（調査・文書作成）',
    repoPath: launchRepo,
    defaultBranch: 'main',
  });
  const webRepo = makeRepo('acme-web', {
    ...DEMO_FILES,
    'README.md': DEMO_FILES['README.md']!.replace('# 認証デモ', '# acme-web'),
  });
  const web = await call('project.create', {
    name: 'acme-web',
    description: '社内向け Web アプリ',
    repoPath: webRepo,
    defaultBranch: 'main',
    testCommand: 'node --test',
  });
  const report = await call('project.create', {
    name: '社内報告',
    description: '週次レポートや議事録（リポジトリなし）',
  });

  const chat = async (title: string, content: string, model: string, projectId?: string) => {
    const s = await call('session.create', {
      kind: 'chat',
      title,
      model,
      ...(projectId ? { projectId } : {}),
    });
    const r = await call('session.send', { sessionId: s.id, content });
    return { session: s, runId: r.runId };
  };
  const ended = (runId: string | null) => daemon.ctx.service('runs').waitForEnd(runId!);

  // ---------------------------------------------------------------- everyday chats
  await ended(
    (
      await chat(
        'Excel の重複行を消したい',
        'Excel で、A 列が同じ行の重複を消す方法を教えて',
        'mock/assistant',
      )
    ).runId,
  );
  await ended(
    (
      await chat(
        'お詫びメールの下書き',
        '納品が 2 日遅れることを取引先に伝えるお詫びメールを書いて。丁寧すぎない感じで',
        'mock/assistant',
      )
    ).runId,
  );
  await ended(
    (
      await chat(
        '週次レポート（10/27 週）',
        '今週の進捗を 3 行でまとめて',
        'mock/assistant',
        report.id,
      )
    ).runId,
  );

  // ---------------------------------------------------------------- non-coding goal (orchestrated)
  const PRESS = [
    '# プレスリリース（案）',
    '',
    '## 家族の予定を、ひとつのノートに。「Komorebi ノート」を 11 月 20 日に発売',
    '',
    '共働き家庭の「予定の伝え漏れ」をなくす、家族向けの予定共有ノートアプリです。',
    '',
    '- 家族の予定をひとつに',
    '- 買い物リストをその場で共有',
    '- 子どもの行事を前日に通知',
    '',
  ].join('\n');
  const goalTasks = [
    {
      title: '競合 3 社の調査',
      body: '家族向け予定共有アプリの競合 3 社について、価格・主な機能・訴求点を表にまとめる。',
      criteria: ['3 社の価格と主な機能が表になっている', '出典が書かれている'],
      plan: {
        steps: [
          { type: 'say', text: '競合 3 社の公式サイトとストアの説明文を確認します。' },
          {
            type: 'write',
            path: 'docs/research/competitors.md',
            content:
              '# 競合調査（作業中）\n\n| 製品 | 価格 | 主な機能 | 訴求点 |\n| --- | --- | --- | --- |\n| A 社 | 月額 600 円 | 予定共有 | 無料プランあり |\n',
          },
          { type: 'say', text: '2 社目の料金ページを読んでいます。' },
          { type: 'sleep', ms: LONG },
        ],
        summary: '競合 3 社の比較表を docs/research/competitors.md にまとめました。',
        delayScale: 1,
      },
    },
    {
      title: 'プレスリリース案を書く',
      body: '発売日・価格・3 つの特長を入れたプレスリリースの初稿を書く。',
      criteria: ['発売日と 3 つの特長が入っている', 'A4 1 枚に収まる'],
      plan: {
        steps: [
          { type: 'say', text: 'docs/product.md の内容をもとに、プレスリリースの初稿を書きます。' },
          { type: 'write', path: 'docs/press-release.md', content: PRESS },
          { type: 'check', path: 'docs/press-release.md', contains: '11 月 20 日' },
        ],
        summary: 'docs/press-release.md に初稿を書きました（価格は仮のため本文から外しています）。',
        delayScale: 0.5,
      },
    },
    {
      title: 'FAQ を 10 問つくる',
      body: '発売時に問い合わせが多そうな質問を 10 問、回答つきで用意する。',
      criteria: ['10 問ある', '価格・対応端末・解約方法が含まれる'],
      plan: {
        steps: [
          { type: 'say', text: 'よくある質問を 10 問、下書きします。' },
          {
            type: 'write',
            path: 'docs/faq.md',
            content:
              '# よくある質問\n\n## 対応している端末は？\niPhone / Android / Web で使えます。\n\n## 家族は何人まで？\n6 人まで招待できます。\n',
          },
          {
            type: 'ask',
            title: '価格（月額 980 円）を FAQ に載せてよいですか？',
            detail:
              '10/28 の定例メモでは価格は「仮」で、正式決定は 11/4 です。載せない場合は「価格は発売時にお知らせします」と書きます。',
            toolName: 'AskHuman',
            onReject: 'continue',
          },
          {
            type: 'append',
            path: 'docs/faq.md',
            content: '\n## 料金は？\n月額 980 円です。\n',
          },
        ],
        summary: 'docs/faq.md に 10 問の FAQ を用意しました。',
        delayScale: 0.5,
      },
    },
    {
      title: '既存顧客への告知メール',
      body: '既存顧客（約 1,200 名）向けの発売告知メールの文面と配信リストを用意する。',
      criteria: ['件名と本文がある', '配信リストの件数が確認できる'],
      plan: {
        steps: [
          { type: 'say', text: '配信リストを確認してから文面を書きます。' },
          {
            type: 'fail',
            message:
              '顧客リスト（data/customers.csv）が見つかりません。\n配信リストの場所を教えてもらうか、CSV をリポジトリに追加してください。',
          },
        ],
        delayScale: 0.5,
      },
    },
  ];

  const tc = (method: string, input: unknown) => ({ name: toolNameForMethod(method), input });
  const ids = (results: { content: string }[]) =>
    results
      .map((r) => {
        try {
          return (JSON.parse(r.content) as { id?: string }).id;
        } catch {
          return undefined;
        }
      })
      .filter((x): x is string => typeof x === 'string');
  // Planner: plain advice without orchestration tools; with them, a scripted plan through
  // the real tools. Turn = model calls since the goal (the last user message).
  mock.define(
    'mock/planner',
    (req, info) => {
      const tools = new Set((req.tools ?? []).map((t) => t.name));
      if (!tools.has(toolNameForMethod('task.spawnWorker'))) {
        return {
          text: ANSWERS.find((a) => a.match.test(info.lastUserText))!.text,
          usage: { costUsd: 0.02 },
        };
      }
      const cost = { usage: { costUsd: 0.2 } };
      if (info.turn === 0) {
        return {
          ...cost,
          text: '目標を 4 つの Task に分けます。競合調査の結果を待たずに、ほかの 3 つは下書きとして並行して進められます。',
          toolCalls: [
            tc('orchestrator.recordDecision', {
              decision: '目標を 4 つの Task に分解し、並列で進める',
              rationale:
                'プレスリリース・FAQ・告知メールは製品概要だけで下書きでき、競合調査の結果は後から反映できるため。',
            }),
            ...goalTasks.map((t) =>
              tc('task.create', {
                projectId: launch.id,
                title: t.title,
                description: [t.body, '', fence(t.plan)].join('\n'),
                acceptanceCriteria: t.criteria,
              }),
            ),
          ],
        };
      }
      if (info.turn === 1) {
        const taskIds = ids(info.toolResults);
        return {
          ...cost,
          text: `${taskIds.length} 人の Worker に任せます。予算は 1 人あたり $0.55 です。`,
          toolCalls: [
            tc('orchestrator.recordDecision', {
              decision: `${taskIds.length} 人の Worker を同時に起動する`,
              rationale: '扱うファイルが重ならないため、同時に進めても衝突しません。',
              taskIds,
            }),
            ...taskIds.map((taskId) =>
              tc('task.spawnWorker', { taskId, runtime: 'mock', budgetUsd: 0.55 }),
            ),
          ],
        };
      }
      if (info.turn === 2) {
        const created = daemon.ctx.repos.tasks
          .find({ where: { project_id: launch.id }, direction: 'asc' })
          .map((t) => t.id);
        return {
          ...cost,
          text: 'Worker が作業を始めました。全員が終わるまで見守ります。',
          toolCalls: [tc('task.wait', { taskIds: created, mode: 'all', timeoutMs: LONG })],
        };
      }
      return { text: '状況を確認しました。', usage: { costUsd: 0.02 } };
    },
    { label: 'モック（プランナー）', chunkDelayMs: 10 },
  );

  const lead = await chat(
    'ローンチ準備の相談',
    '来月 20 日に新製品を出すんだけど、ローンチ準備って何から手を付けるべき？',
    'mock/planner',
    launch.id,
  );
  await ended(lead.runId);
  await call('session.grantOrchestration', {
    sessionId: lead.session.id,
    maxWorkers: 4,
    lifetime: 'session',
    budgetUsd: 3,
  });
  await call('session.send', {
    sessionId: lead.session.id,
    content: 'いいね、その 4 つを並行して進めて。予算は $3 まで',
  });

  // ---------------------------------------------------------------- coding goal (mock/orchestrator)
  const dev = await call('session.create', {
    kind: 'chat',
    projectId: web.id,
    title: 'ログイン改善の相談',
    model: 'mock/orchestrator',
  });
  await call('session.grantOrchestration', {
    sessionId: dev.id,
    maxWorkers: 2,
    lifetime: 'session',
    budgetUsd: 5,
  });
  await call('session.send', {
    sessionId: dev.id,
    content: 'ログインまわりのドキュメントとテストを並列で整備して',
  });

  // A human-started agent that keeps working.
  const depWs = await call('workspace.create', { projectId: web.id, label: 'deps-update' });
  const dep = await call('session.create', {
    kind: 'agent',
    projectId: web.id,
    workspaceId: depWs.id,
    title: '依存パッケージの更新',
    runtime: 'mock',
  });
  await call('session.send', {
    sessionId: dep.id,
    content: [
      '古くなった依存パッケージを洗い出して、更新の影響をまとめて',
      '',
      fence({
        steps: [
          { type: 'say', text: 'package.json と lockfile を確認します。' },
          {
            type: 'write',
            path: 'docs/deps-report.md',
            content: '# 依存パッケージの更新（調査中）\n\n- 対象: 12 パッケージ\n',
          },
          { type: 'say', text: '各パッケージの変更履歴を読んでいます。' },
          { type: 'sleep', ms: LONG },
        ],
        delayScale: 1,
      }),
    ].join('\n'),
  });

  // ---------------------------------------------------------------- wait for the shape of the day
  await until(
    'the launch tasks to settle into running / review / approval / failed',
    async () => {
      const tasks = daemon.ctx.repos.tasks.find({
        where: { project_id: launch.id },
        direction: 'asc',
      });
      if (tasks.length < 4) return null;
      const by = (title: string) => tasks.find((t) => t.title === title);
      const pending = await call('approval.list', { status: ['pending'] });
      return (
        by('プレスリリース案を書く')?.status === 'review' &&
        by('既存顧客への告知メール')?.status === 'failed' &&
        pending.items.length > 0
      );
    },
    90_000,
  );
  await until(
    'the acme-web integration to wait for review',
    async () => {
      const list = await call('integration.list', { projectId: web.id });
      return list.items.find((i) => i.status === 'awaiting_approval');
    },
    120_000,
  );

  // Last: a long answer still streaming while the UI is captured.
  await chat(
    'ブログ記事: リモートワークの 1 年',
    'リモートワークを 1 年続けて気づいたことを、社外ブログ向けに 1,500 字くらいで書いて',
    'mock/writer',
  );

  console.log('scene ready');
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
