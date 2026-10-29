/**
 * UI audit scene (dev only, ui-redesign spec §10): more than ten agents "working" at once,
 * built through the REAL Core Daemon and Control API with mock models and the mock agent
 * runtime only (no LLM endpoint, no cost).
 *
 *   A 「新製品ローンチ準備」 delegated, no project: 5 children (no workspace) — 2 working
 *     (long sleeps, `now` shows), 1 asking a question with choices, 1 failed, 1 done with a
 *     document. The tree has used about 80% of its budget.
 *   B 「ログイン改善」 delegated, a git project: 3 children (worktrees) — 2 waiting for review
 *     (code outputs), 1 working that waits for a command approval.
 *   C 「市場レポート」 delegated, a folder project: 2 children (the folder) — 1 working, 1
 *     queued after it.
 *   「朝のまとめ」 a schedule (every morning 9:00) that fired once and finished; next run set.
 *   Plain chats: 2 done (「お詫びメールの下書き」「Excel の重複を消したい」), 1 still streaming.
 *   Daily limit $20, today's spend a few dollars.
 *
 * The supervisors really call `session.spawn` (their first reply to the goal; after that the
 * built-in mock supervisor). Repositories live inside ACC_HOME, so removing
 * ACC_HOME removes everything except the folder project, which lives beside it in
 * `<ACC_HOME>-market` (a workspace may not be inside ACC_HOME).
 *
 *   ACC_HOME=<dir> ACC_PORT=<port> pnpm --filter @acc/desktop exec tsx scripts/audit-scene.ts [--hold]
 *
 * --hold   start the daemon, print "daemon ready", and build the scene only after a line
 *          arrives on stdin (so a UI can first be captured empty). e2e/audit.js drives this.
 * Prints "scene ready" when everything is in place, then one JSON line `scene {...}` with
 * the ids of the sessions the screenshots open. Running parts keep running ~10 minutes.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
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
// Never reach a real LLM endpoint (or a real Claude) from the scene.
delete process.env.ACC_LITELLM_BASE_URL;
delete process.env.ACC_LITELLM_API_KEY;
for (const k of Object.keys(process.env)) if (k.startsWith('ANTHROPIC_')) delete process.env[k];

/** Longest mock sleep (10 min): "still working" for the whole capture. */
const LONG = 600_000;

const plan = (text: string, steps: unknown[], summary?: string, delayScale = 0.3) =>
  [text, '', '```acc-mock', JSON.stringify({ steps, delayScale, ...(summary ? { summary } : {}) }, null, 2), '```'].join(
    '\n',
  );

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
  writeFiles(dir, files);
  git('add', '-A');
  git('commit', '-q', '-m', 'Initial commit');
  return dir;
}

function writeFiles(dir: string, files: Record<string, string>): void {
  for (const [file, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, file)), { recursive: true });
    writeFileSync(join(dir, file), content);
  }
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
      '元のデータを残したいときは、`=UNIQUE(A2:D200)` で別の場所に重複なしの一覧を作る方法もあります。',
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
      'ご依頼いただいております資料一式につきまして、確認工程に想定以上の時間を要しており、納品日を **11 月 7 日（金）** へ変更させていただきたく、ご連絡いたしました。',
      '',
      'ご迷惑をおかけし、誠に申し訳ございません。何卒よろしくお願い申し上げます。',
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
  '会議で決めたことをその場で 3 行に書き、チャンネルに貼る。それだけで「あれってどうなったんだっけ」という確認がほとんどなくなりました。',
  '',
  '## 3. 終わりの時間を決める',
  '',
  '家で働いていると、仕事の終わりがあいまいになります。私は 18 時にノート PC を閉じて、別の部屋に置くことにしました。物理的に離すのが、いちばん効きました。',
].join('\n');

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

const GOAL_A = '来月 20 日に新製品「Komorebi ノート」を出す。発売までの準備を進めて';
const GOAL_B = 'ログイン画面のエラーメッセージとテストを直して';
const GOAL_C = '家族向けアプリの市場レポートを作って';

async function main(): Promise<void> {
  // Imported after the warning filter is installed (like the daemon's own main.ts).
  const { createLogger, parseLogLevel } = await import('../../../packages/daemon/src/core/log');
  const { startDaemon } = await import('../../../packages/daemon/src/daemon');
  const { DEMO_FILES } = await import('../../../packages/daemon/src/orchestrator/demo');
  const { mockSupervisor } = await import('../../../packages/daemon/src/orchestrator/mockSupervisor');
  const { toolNameForMethod, methodForToolName } = await import('../../../packages/daemon/src/llm/tools');
  const daemon = await startDaemon({
    home,
    log: createLogger(parseLogLevel(process.env.ACC_LOG_LEVEL ?? 'warn')),
  });
  const call = <M extends MethodName>(m: M, p: ParamsInput<M>, actor: Actor = HUMAN): Promise<Result<M>> =>
    daemon.call(actor, m, p as never);
  const until = async <T>(
    what: string,
    fn: () => Promise<T | null | undefined | false>,
    detail?: () => Promise<unknown>,
    ms = 90_000,
  ): Promise<T> => {
    const end = Date.now() + ms;
    for (;;) {
      const v = await fn();
      if (v) return v;
      if (Date.now() > end) {
        const more = detail ? `
${JSON.stringify(await detail(), null, 1)}` : '';
        throw new Error(`audit-scene: timed out waiting for ${what}${more}`);
      }
      await new Promise((r) => setTimeout(r, 200));
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
      res.end(JSON.stringify({ data: [{ id: 'claude-sonnet-4-5' }, { id: 'claude-haiku-4-5' }] }));
      return;
    }
    res.writeHead(503, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'audit-scene stub: no real LLM calls' } }));
  });
  await new Promise<void>((res) => stub.listen(0, '127.0.0.1', res));
  daemon.ctx.onClose(() => void stub.close());
  const stubPort = (stub.address() as { port: number }).port;
  await call('settings.update', {
    litellm: { baseUrl: `http://127.0.0.1:${stubPort}/v1` },
    defaultRuntime: 'mock',
    defaultModel: 'mock/assistant',
    limits: { dailyUsd: 20 },
  });

  // ---------------------------------------------------------------- mock models
  const mock = daemon.ctx.service('llm').mock;
  mock.define(
    'mock/assistant',
    (_req, info) => ({
      text: ANSWERS.find((a) => a.match.test(info.lastUserText))?.text ?? 'わかりました。もう少し詳しく教えてください。',
      usage: { costUsd: 0.004 },
    }),
    { label: 'モック（アシスタント）', chunkDelayMs: 5 },
  );
  // A long answer streamed slowly: "still writing" for minutes.
  mock.define('mock/writer', () => ({ text: BLOG, usage: { costUsd: 0.012 } }), {
    label: 'モック（ライター）',
    chunkDelayMs: 900,
    chunkSize: 1,
  });

  // ---------------------------------------------------------------- projects
  const webRepo = makeRepo('acme-web', {
    ...DEMO_FILES,
    'README.md': '# acme-web\n\n社内向け Web アプリ。\n',
  });
  const web = await call('project.create', {
    name: 'acme-web',
    repoPath: webRepo,
    defaultBranch: 'main',
    testCommand: 'node --test',
    // "標準": adding a dependency asks first (the approval of tree B).
    permissionProfile: 'standard',
  });
  // A user's folder beside ACC_HOME (the app's data folder cannot be a workspace). e2e/audit.js
  // removes it with ACC_HOME; a scene run on its own removes it when it exits.
  const marketDir = `${home.replace(/[\\/]+$/, '')}-market`;
  mkdirSync(marketDir, { recursive: true });
  process.on('exit', () => rmSync(marketDir, { recursive: true, force: true, maxRetries: 5 }));
  writeFiles(marketDir, {
    'notes/interviews.md': '# インタビュー（10 月）\n\n- 共働き 3 家庭\n- 予定の共有は LINE とカレンダーの併用\n',
    'data/survey.csv': 'q,yes,no\n予定を共有している,62,38\n',
  });
  const market = await call('project.create', { name: '市場レポート', folderPath: marketDir });

  // ---------------------------------------------------------------- supervisors
  type Spawn = ParamsInput<'session.spawn'>;
  /** What each supervisor spawns on its goal: one list per model call (later ones see ids). */
  const LEADS: { goal: string; waves: ((prev: string[]) => Spawn[])[]; text: string }[] = [
    {
      goal: GOAL_A,
      text: '5 つに分けて任せます。',
      waves: [
        () => [
          {
            title: '競合 3 社の調査',
            goal: plan(
              '家族向け予定共有アプリの競合 3 社について、価格・主な機能・訴求点を表にまとめてください。',
              [
                { type: 'say', text: '競合 3 社の公式サイトとストアの説明文を確認します。' },
                { type: 'usage', costUsd: 1.0 },
                { type: 'write', path: 'competitors.md', content: '# 競合調査（作業中）\n' },
                { type: 'sleep', ms: LONG },
              ],
            ),
            doneWhen: ['3 社の価格と主な機能が表になっている', '出典が書かれている'],
            workspace: { kind: 'none' },
            budgetUsd: 1.1,
          },
          {
            title: '告知メールの文面',
            goal: plan('既存顧客（約 1,200 名）向けの発売告知メールの件名と本文を書いてください。', [
              { type: 'say', text: '件名の案を 3 つ出してから本文を書きます。' },
              { type: 'usage', costUsd: 0.65 },
              { type: 'write', path: 'mail.md', content: '# 告知メール（下書き）\n' },
              { type: 'sleep', ms: LONG },
            ]),
            workspace: { kind: 'none' },
            budgetUsd: 0.7,
          },
          {
            title: 'FAQ を 10 問つくる',
            goal: plan('発売時に問い合わせが多そうな質問を 10 問、回答つきで用意してください。', [
              { type: 'say', text: 'よくある質問を 10 問、下書きします。' },
              { type: 'usage', costUsd: 0.38 },
              { type: 'write', path: 'faq.md', content: '# よくある質問\n\n## 対応している端末は？\niPhone / Android / Web\n' },
              {
                type: 'ask',
                title: '価格（月額 980 円）を FAQ に載せてよいですか？',
                detail: '10/28 の定例メモでは価格は「仮」で、正式決定は 11/4 です。載せない場合は「価格は発売時にお知らせします」と書きます。',
                choices: ['載せる', '発売時に案内'],
              },
              { type: 'append', path: 'faq.md', content: '\n## 料金は？\n月額 980 円です。\n' },
            ]),
            workspace: { kind: 'none' },
            budgetUsd: 0.45,
          },
          {
            title: '配信リストの整理',
            goal: plan('告知メールの配信リスト（既存顧客）を重複なしで用意してください。', [
              { type: 'say', text: '顧客リストを確認します。' },
              { type: 'usage', costUsd: 0.22 },
              { type: 'fail', message: '顧客リスト（customers.csv）が見つかりません。' },
            ]),
            workspace: { kind: 'none' },
            budgetUsd: 0.3,
          },
          {
            title: 'プレスリリース案',
            goal: plan(
              '発売日・価格・3 つの特長を入れたプレスリリースの初稿を書いてください。',
              [
                { type: 'say', text: '製品概要をもとに初稿を書きます。' },
                { type: 'usage', costUsd: 0.42 },
                { type: 'write', path: 'press-release.md', content: PRESS },
                { type: 'publish', kind: 'document', title: 'プレスリリース（案）', path: 'press-release.md' },
              ],
              'プレスリリースの初稿を書きました（価格は仮のため本文から外しています）。',
            ),
            workspace: { kind: 'none' },
            budgetUsd: 0.45,
          },
        ],
      ],
    },
    {
      goal: GOAL_B,
      text: '3 つに分けて、コードの変更は確認してもらいます。',
      waves: [
        () => [
          {
            title: 'エラーメッセージを直す',
            goal: plan('ログイン失敗時のメッセージを、原因が分かる日本語に直してください。', [
              { type: 'say', text: 'src/auth.js のメッセージを直します。' },
              { type: 'usage', costUsd: 0.21 },
              { type: 'write', path: 'src/messages.js', content: "export const LOGIN_FAILED = 'メールアドレスかパスワードが違います';\n" },
            ], 'ログイン失敗のメッセージを直しました。'),
            workspace: { kind: 'worktree', projectId: web.id },
            projectId: web.id,
            reviewBy: 'human',
            budgetUsd: 0.5,
          },
          {
            title: 'ログインのテストを足す',
            goal: plan('ログイン失敗とロックのテストを追加してください。', [
              { type: 'say', text: 'ログインのテストを追加します。' },
              { type: 'usage', costUsd: 0.24 },
              { type: 'write', path: 'test/login.test.js', content: "import test from 'node:test';\n\ntest('locks after 5 failures', () => {});\n" },
            ], 'テストを 2 件追加しました。'),
            workspace: { kind: 'worktree', projectId: web.id },
            projectId: web.id,
            reviewBy: 'human',
            budgetUsd: 0.5,
          },
          {
            title: '入力チェックを入れる',
            goal: plan('ログインフォームの入力チェックを、検証ライブラリで書き直してください。', [
              { type: 'say', text: '検証ライブラリを追加してから書き直します。' },
              { type: 'usage', costUsd: 0.12 },
              { type: 'write', path: 'src/validate.js', content: '// 入力チェック（作業中）\n' },
              { type: 'run', command: 'pnpm', args: ['add', 'zod'], title: 'zod を追加', onReject: 'continue', allowFailure: true },
              { type: 'sleep', ms: LONG },
            ]),
            workspace: { kind: 'worktree', projectId: web.id },
            projectId: web.id,
            budgetUsd: 0.5,
          },
        ],
      ],
    },
    {
      goal: GOAL_C,
      text: '調べてから書きます。',
      waves: [
        () => [
          {
            title: '市場規模を調べる',
            goal: plan('家族向けアプリの国内の市場規模と伸びを調べて、notes/market.md にまとめてください。', [
              { type: 'say', text: 'notes と data の資料を読んでいます。' },
              { type: 'usage', costUsd: 0.27 },
              { type: 'write', path: 'notes/market.md', content: '# 市場規模（作業中）\n' },
              { type: 'sleep', ms: LONG },
            ]),
            workspace: { kind: 'folder', path: marketDir },
            projectId: market.id,
            budgetUsd: 0.6,
          },
        ],
        (prev) => [
          {
            title: 'レポートを書く',
            goal: plan('調べた結果から 2 ページのレポートを書いてください。', [
              { type: 'write', path: 'report.md', content: '# 市場レポート\n' },
              { type: 'publish', kind: 'document', title: '市場レポート', path: 'report.md' },
            ]),
            workspace: { kind: 'folder', path: marketDir },
            projectId: market.id,
            after: prev.slice(0, 1),
            budgetUsd: 0.6,
          },
        ],
      ],
    },
  ];
  const tc = (method: string, input: unknown) => ({ name: toolNameForMethod(method), input });
  const spawnedIds = (results: { content: string }[]) =>
    results
      .map((r) => {
        try {
          return (JSON.parse(r.content) as { session?: { id?: string } }).session?.id;
        } catch {
          return undefined;
        }
      })
      .filter((x): x is string => typeof x === 'string');
  mock.define(
    'mock/audit-lead',
    (req, info) => {
      const tools = new Set((req.tools ?? []).map((t) => methodForToolName(t.name)));
      const lead = LEADS.find((l) => info.lastUserText.trim() === l.goal);
      const wave = lead?.waves[info.turn];
      if (lead && wave && tools.has('session.spawn')) {
        return {
          text: info.turn === 0 ? lead.text : '続きを任せます。',
          toolCalls: wave(spawnedIds(info.toolResults)).map((p) => tc('session.spawn', p)),
          usage: { costUsd: 0.03 },
        };
      }
      return { ...mockSupervisor(req, info), usage: { costUsd: 0.02 } };
    },
    { label: 'モック（指揮役）', chunkDelayMs: 4 },
  );

  const delegated = async (title: string, goal: string, opts: { projectId?: string; budgetUsd: number }) => {
    const s = await call('session.create', {
      kind: 'chat',
      title,
      model: 'mock/audit-lead',
      ...(opts.projectId ? { projectId: opts.projectId } : {}),
    });
    await call('session.delegate', {
      sessionId: s.id,
      budgetUsd: opts.budgetUsd,
      maxChildren: 6,
      ...(opts.projectId ? { projectId: opts.projectId } : { projectId: null }),
    });
    await call('session.send', { sessionId: s.id, content: goal });
    return s;
  };

  // ---------------------------------------------------------------- everyday chats
  const ended = (runId: string | null) => daemon.ctx.service('runs').waitForEnd(runId!);
  const chat = async (title: string, content: string, model: string) => {
    const s = await call('session.create', { kind: 'chat', title, model });
    const r = await call('session.send', { sessionId: s.id, content });
    return { session: s, runId: r.runId };
  };
  await ended((await chat('Excel の重複を消したい', 'Excel で、A 列が同じ行の重複を消す方法を教えて', 'mock/assistant')).runId);
  await ended(
    (await chat('お詫びメールの下書き', '納品が 2 日遅れることを取引先に伝えるお詫びメールを書いて', 'mock/assistant')).runId,
  );

  // ---------------------------------------------------------------- a schedule that already ran
  const morning = await call('session.create', { kind: 'chat', title: '朝のまとめ', model: 'mock/assistant' });
  const schedule = await call('schedule.create', {
    sessionId: morning.id,
    title: '朝のまとめ',
    prompt: plan(
      '昨日の受信メールと予定から、今日やることを 5 行でまとめてください。',
      [
        { type: 'say', text: '昨日のメールと今日の予定を読みます。' },
        { type: 'usage', costUsd: 0.06 },
        { type: 'publish', kind: 'document', title: '今日のまとめ', content: '- 10:00 定例\n- 見積もりの返信（A 社）\n- 請求書の確認\n' },
      ],
      '今日のまとめを書きました。',
      0,
    ),
    trigger: { kind: 'cron', expr: '0 9 * * *' },
    run: { mode: 'agent', budgetUsd: 0.5 },
  });
  const fired = await call('schedule.runNow', { scheduleId: schedule.id });

  // ---------------------------------------------------------------- the three trees
  // Children take $3.00 of it; the rest keeps the supervisor's own calls going (one call
  // reserves $0.25).
  const a = await delegated('新製品ローンチ準備', GOAL_A, { budgetUsd: 3.4 });
  const b = await delegated('ログイン改善', GOAL_B, { projectId: web.id, budgetUsd: 3 });
  const c = await delegated('市場レポート', GOAL_C, { projectId: market.id, budgetUsd: 2 });

  const tree = async (id: string) => (await call('session.tree', { sessionId: id })).nodes;
  const states = async (id: string) => (await tree(id)).filter((n) => n.depth > 0).map((n) => n.state);
  const count = (xs: string[], s: string) => xs.filter((x) => x === s).length;
  /** What a tree looks like and what its root said (when the scene does not come together). */
  const explain = async (id: string) => ({
    nodes: (await tree(id)).map((n) => `${n.depth} ${n.state} ${n.title} ${n.now ?? ''}`),
    said: (await call('session.messages', { sessionId: id, limit: 20 })).items.map((m) =>
      `${m.role}: ${m.content.map((p) => (p.type === 'text' ? p.text : p.type === 'tool_result' ? JSON.stringify(p.output).slice(0, 300) : p.type)).join(' | ').slice(0, 400)}`,
    ),
  });
  await until('tree A: 2 working, 1 asking, 1 failed, 1 done', async () => {
    const s = await states(a.id);
    return count(s, 'working') === 2 && count(s, 'needs_you') === 1 && count(s, 'failed') === 1 && count(s, 'done') === 1;
  }, () => explain(a.id));
  await until('tree B: 2 waiting for review, 1 waiting for an approval', async () => {
    const s = await states(b.id);
    return count(s, 'review') === 2 && count(s, 'needs_you') === 1;
  }, () => explain(b.id));
  await until('tree C: 1 working, 1 queued', async () => {
    const s = await states(c.id);
    return count(s, 'working') === 1 && count(s, 'queued') === 1;
  }, () => explain(c.id));
  await until('the morning summary done', async () => (await states(morning.id)).includes('done'), () => explain(morning.id));

  // Last: a long answer still streaming while the UI is captured.
  const blog = await chat(
    'ブログ記事: リモートワークの 1 年',
    'リモートワークを 1 年続けて気づいたことを、社外ブログ向けに 1,500 字くらいで書いて',
    'mock/writer',
  );
  await new Promise((r) => setTimeout(r, 3000));

  const byTitle = async (root: string, title: string) => (await tree(root)).find((n) => n.title === title)?.id ?? null;
  const ids = {
    a: a.id,
    b: b.id,
    c: c.id,
    morning: morning.id,
    morningRun: fired.sessionId,
    blog: blog.session.id,
    aWorking: await byTitle(a.id, '競合 3 社の調査'),
    aQuestion: await byTitle(a.id, 'FAQ を 10 問つくる'),
    aFailed: await byTitle(a.id, '配信リストの整理'),
    aDone: await byTitle(a.id, 'プレスリリース案'),
    bReview: await byTitle(b.id, 'エラーメッセージを直す'),
    bApproval: await byTitle(b.id, '入力チェックを入れる'),
  };
  console.log('scene ready');
  console.log(`scene ${JSON.stringify(ids)}`);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
