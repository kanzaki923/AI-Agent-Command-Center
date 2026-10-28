# 開発ガイド

構成と契約は `architecture.md`、ここは「手を動かすときの手順と約束ごと」。

## 1. セットアップと日常コマンド

前提：Node.js 22.12 以上、pnpm 10。

```sh
pnpm install
pnpm dev:daemon          # Core Daemon を tsx watch で起動（127.0.0.1:47821）
pnpm acc status          # CLI（daemon.json を読んで接続）
pnpm acc sessions
pnpm acc events -f       # イベントを追従表示
pnpm dev:desktop         # UI をブラウザで起動（127.0.0.1:5173。ACC_HOME の daemon.json に接続）

pnpm lint                # ESLint（型情報つき。.claude/ 配下のエージェント用 worktree などは対象外）
pnpm typecheck           # 全パッケージ tsc --noEmit
pnpm test                # vitest（全プロジェクト）
pnpm check               # 上の 3 つ。コミット前に必ず通す
pnpm format              # Prettier
```

環境変数（すべて任意）：

| 変数 | 既定 | 用途 |
|---|---|---|
| `ACC_HOME` | `~/.acc` | データディレクトリ（`acc.sqlite`、`config.json`、`daemon.json`、`worktrees/`） |
| `ACC_PORT` | `47821` | 待ち受けポート（`config.json` の `port` より優先） |
| `ACC_LOG_LEVEL` | `info` | `debug` / `info` / `warn` / `error` / `silent` |
| `ACC_LITELLM_BASE_URL` / `ACC_LITELLM_API_KEY` | なし | `config.json` の LiteLLM 設定を上書き（保存はしない） |

開発中に本番のデータと混ぜたくないときは `ACC_HOME` を別ディレクトリにする。

Desktop UI（`apps/desktop`）：

```sh
pnpm --filter @acc/desktop scene        # 本物のデーモン + 本物の API で作る確認用の場面（一時 git リポジトリ、Worker、承認待ち、統合候補。ACC_PORT 既定 47899。--empty / --load 10）
pnpm --filter @acc/desktop tauri:dev    # Tauri アプリ（デーモンが無ければ起動）
pnpm --filter @acc/desktop screenshots  # Playwright で主要画面を撮る（scene に対して。出力は OS の一時ディレクトリ）
pnpm --filter @acc/desktop e2e:slice    # 本物のデーモン + Vite を一時 ACC_HOME で起動し、オンボーディング → デモ → 送信 → 承認 → 統合の反映まで通す（--daemon-root で別チェックアウトのデーモンも使える）
pnpm --filter @acc/desktop e2e:perf     # 本番ビルドで 10 本同時ストリーミングのフレーム間隔と長いタスクを測る（--profile で内訳、--dev で開発サーバ）
```

UI とデーモンは同じ `ACC_HOME` を見る（Vite の開発ミドルウェアが `daemon.json` を `/__acc/connection` で渡す）。scene は代役を使わず、すべて Control API を通して作るので、実際の挙動を隠さない。

## 2. パッケージ構成

```
packages/protocol   @acc/protocol  zod スキーマと型だけ。node の import 禁止（ブラウザでも使う）
  src/common.ts       ID・Timestamp・Actor・ページング
  src/domain.ts       Project / Workspace / Session / Message / Task / Run / Artifact /
                      Integration / Approval / CapabilityGrant / BudgetAllocation / Settings
  src/events.ts       eventPayloads（イベント型の唯一の定義）・Event・EventFilter・Delta
  src/api.ts          Control API 契約（メソッド → params / result / permission / description）
  src/wire.ts         JSON-RPC 封筒・エラーコード・定数
  src/patterns.ts     "task.*" 形式のパターン照合・イベントフィルタ
packages/client     @acc/client    型付き WebSocket クライアント（ブラウザ / Node 共通）
  src/node.ts         @acc/client/node：daemon.json の読み取り（Node 専用）
packages/daemon     @acc/daemon    Core Daemon
  src/core/           DB・マイグレーション・リポジトリ・EventBus・ID・時刻・設定・リカバリ・Context
  src/api/            defineMethod・レジストリ・ディスパッチャ・PolicyEngine・サーバ
  src/<module>/       機能モジュール（system, events, projects, sessions, policy, llm, runs,
                      runtime, workspace, tasks, orchestrator, integration）
  src/modules.ts      モジュール一覧（登録・マイグレーションの順序）
  src/testing.ts      @acc/daemon/testing：テスト用ヘルパ
packages/cli        @acc/cli       `acc` コマンド
```

- 内部パッケージはビルドしない。`exports` が `src/*.ts` を直接指し、tsx / vitest / Vite がそのまま読む。
- TypeScript は strict + `noUncheckedIndexedAccess`、`moduleResolution: Bundler`。相対 import は拡張子なし。
- `@acc/protocol` は TS 6 の `types: []` で node の型を読まない。node の API を使うと typecheck で落ちる。

## 3. メソッドを追加・実装する

1. **契約**：`packages/protocol/src/api.ts` にエントリを足す（既にあれば不要）。
   - `params` は `z.strictObject`（ヘルパ `params(...)`）。省略可能な値は `.default()` で既定を決める。
   - `description` は英語で、LLM が読んで使い方がわかる文にする。
   - LLM に出したくないもの（設定変更、WS 専用）は `tool: false`。状態を変えるものは `mutates: true`。ブロックするものは `longPoll: true`（クライアントがタイムアウトを延ばす）。
2. **実装**：担当モジュールの `register(ctx)` で登録する。

   ```ts
   ctx.methods.register(
     defineMethod('task.get', {
       scope: (p) => {
         const task = ctx.repos.tasks.get(p.taskId);
         return { projectIds: task ? [task.projectId] : [] };
       },
       handler: (p) => ctx.repos.tasks.require(p.taskId),
     }),
   );
   ```

   - params・result の型は契約から推論される。検証はディスパッチャが行うので、ハンドラで zod を呼ばない。
   - プロジェクトに関わるメソッドは必ず `scope` を書く（Capability のプロジェクト制限に使う）。
   - 失敗は `core/errors.ts` のヘルパ（`notFound` / `invalidParams` / `conflict` / `forbidden` / `limitExceeded` / `budgetExceeded`）で投げる。それ以外の例外は `internal` になる。
   - 状態変更は `ctx.db.transaction(() => { 更新; ctx.bus.emit(...) })` にまとめる。トランザクション内で `await` しない。
   - 長くブロックするハンドラは `call.signal`（切断・停止で abort）を見る。
3. **テスト**：同じコミットで足す（下記 §6）。

## 4. モジュールを追加する

1. `packages/daemon/src/<name>/index.ts` で `defineModule({ name, migrations?, register })` を export。
2. `src/modules.ts` に追加。
3. 他モジュールに機能を提供するならサービスにする。

   ```ts
   declare module '../core/context' {
     interface Services { runs: RunManager }
   }
   ctx.provide('runs', new RunManager(ctx));   // register 内
   ctx.service('runs').start(...)              // 使う側（呼び出し時に取得。register 時に取らない）
   ```

4. タイマーやスケジューラは `register` の戻り値 `{ start(), stop() }` で開始・停止する。

## 5. イベント・テーブルを追加する

- **イベント**：`protocol/src/events.ts` の `eventPayloads` に 1 行足すだけで union・型・検証が揃う。payload は「変化後のエンティティ全体 + `changes`」を基本形にする（UI が差分を当てやすい）。CLI の `format.ts` の `summarizeEvent` も更新する（switch が網羅性チェックで落ちる）。
- **テーブル / 絞り込み列**：モジュールの `migrations` に `{ id: '<module>/0002_xxx', sql }` を追加。出荷済みのマイグレーションは書き換えない。既存エンティティの列なら `core/repos.ts` の `columns` も足す。
- **エンティティのフィールド**：`protocol/src/domain.ts` に足すだけ（JSON 列なのでマイグレーション不要）。古い行のために `.default()` か `.nullable()` を付ける。

## 6. テスト

- vitest。各パッケージの `src/**/*.test.ts`。ルートの `vitest.config.ts` が `packages/*/vitest.config.ts` と `apps/*/vitest.config.ts` をプロジェクトとして束ねる。
- デーモンを使うテストは `@acc/daemon/testing` を使う。一時 `ACC_HOME`・ポート 0・ログ無音で、プロセスの環境変数は引き継がない。

  ```ts
  import { HUMAN, agentActor, createTestDaemon, startTestDaemon, connectTestClient } from '@acc/daemon/testing';

  const d = await createTestDaemon();                 // ネットワークなし。d.call(HUMAN, method, params)
  const s = await startTestDaemon();                  // HTTP + WS つき
  const client = await connectTestClient(s);          // 型付きクライアント
  await d.cleanup();                                  // 停止 + 一時ディレクトリ削除
  ```

- 任意の状態の Task が要るテストは `insertTestTask(d.ctx, { projectId, ...上書き })`（`@acc/daemon/testing`）を使う。Task のリテラルを手で書かない（スキーマにフィールドが増えるたびに壊れる）。desktop は `src/test/fixtures.ts` の同種のファクトリを使う。
- モジュールをまたぐ流れ（agent Run → コミット → Artifact → 統合、Task キャンセル → Run 停止）は `src/e2e.test.ts` が本物の全モジュールで確かめる。サービスを偽物に差し替えた単体テストでは継ぎ目の食い違いが見えないため、契約を変えたらここも通す。
- 時刻は `createManualClock()` を `createDaemon({ clock })` に渡して制御する。
- 再起動を伴うテストは `startTestDaemon({ home })` で同じ `ACC_HOME` を使い回す（例：`server.test.ts` のリカバリ）。
- 本物の有料 LLM API はテストで呼ばない。llm / runtime の mock を使う。
  - `d.ctx.service('llm').mock.chunkDelayMs = 0` で mock の送信間隔をなくす。台本は `mock.define('mock/x', scripted([{ text, toolCalls }, (req, info) => ({ text })]))`（`scripted` は `src/llm` から）。
  - LiteLLM 経路は `node:http` のローカル偽サーバに `settings.update({ litellm: { baseUrl } })` を向けて試す（例：`llm/llm.test.ts`）。
- Run の Executor は `ctx.service('runs').registerExecutor(kind, fn)` で差し替えられる（後勝ち）。

## 7. 約束ごと

- UI・CLI の文言は日本語、コード・コメント・API の `description` は英語。
- API キー・トークンをイベント・ログ・API レスポンスに平文で出さない。
- `node:sqlite` の ExperimentalWarning は想定内（`main.ts` と vitest の `execArgv` で抑止済み）。
