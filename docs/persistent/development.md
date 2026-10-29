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
pnpm acc daemon stop     # Core Daemon を止める（実行中の Run があれば --force が必要）
pnpm dev:desktop         # デスクトップアプリを開発モードで起動（下記 §1.1）
pnpm dev:web             # UI をブラウザで起動（127.0.0.1:5173。ACC_HOME の daemon.json に接続）
pnpm build:desktop       # 配布用ビルド（下記 §1.2）

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
| `ACC_CLAUDE_CODE_PATH` | なし | Claude Code の実行ファイル（`claude.exe`）。未指定なら自動で探す（§1.2） |
| `ACC_BUILD_CACHE` | OS のキャッシュ（Windows は `%LOCALAPPDATA%\acc-build-cache`） | 配布ビルド用 Node のダウンロード置き場 |

開発中に本番のデータと混ぜたくないときは `ACC_HOME` を別ディレクトリにする。

**データの場所**：すべて `ACC_HOME`（既定 `~/.acc`）。`acc.sqlite`、`config.json`、`daemon.json`（起動中だけ）、`worktrees/`、`demo/`、`logs/daemon-launch.log`（アプリが起動したデーモンの出力。5MB を超えたら `.1` に回す）。アプリ自身の状態（ウィンドウ位置・大きさ）は Tauri の app data（Windows は `%APPDATA%\com.acc.desktop`）、WebView のデータは `%LOCALAPPDATA%\com.acc.desktop`。

**デーモンの止め方**：アプリを閉じてもデーモンは動き続ける（定期実行・長時間のエージェントを止めないため）。止めるときはアプリを閉じてから `pnpm acc daemon stop`（実行中の Run があると断られる。`--force` でそれらを中断して停止）。アプリを開いたまま止めると、アプリが新しいデーモンをすぐ起動し直す。中身は `system.shutdown`（人間だけ。LLM ツールには出さない）。

### 1.1 デスクトップアプリの開発

`pnpm dev:desktop`（`scripts/dev-desktop.js`）が 1 つのターミナルで次を行う：

1. 同じ `ACC_HOME` でデーモンが動いていなければ `pnpm dev:daemon`（tsx watch）を起動し、`/health` が返るまで待つ。動いていればそれに接続する（ソースの変更は反映されないので、反映したいときは `pnpm acc daemon stop` してから実行し直す）。
2. `tauri dev`（Vite + Rust のシェル）。シェルは `daemon.json` から 1. のデーモンを見つけるので、自分では起動しない。

ウィンドウを閉じるか Ctrl+C で、このスクリプトが起動したもの（Vite・アプリ・watch のデーモン）をすべて止める（デーモンは `acc daemon stop --force` で行儀よく止める）。初回は Rust の依存ビルドに数分かかる。

### 1.2 配布ビルド（パッケージング）

```sh
pnpm build:desktop                                  # release + NSIS インストーラ
pnpm --filter @acc/desktop tauri build --debug      # 確認用（target/debug/acc-desktop.exe もそのまま起動できる）
pnpm --filter @acc/desktop tauri build --no-bundle  # exe だけ（インストーラを作らない）
```

`tauri build` の `beforeBuildCommand` が Vite のビルドと `node scripts/prepare-sidecar.js --release` を実行し、次を揃える（どちらも `.gitignore` 済み。コミットしない）：

- `src-tauri/binaries/acc-node-<target-triple>.exe`：Node ランタイム。バージョンと SHA-256 を `prepare-sidecar.js` の `NODE_RUNTIME` に固定し、nodejs.org から 1 度だけ取得してビルドキャッシュに置く。以降はキャッシュを検証して使うのでオフラインでもビルドできる。ハッシュが合わないものは使わない。上げるときは Node 22 LTS の `SHASUMS256.txt` から値を写す。
- `src-tauri/resources/daemon/main.mjs`（+ `.map`）：`packages/daemon/scripts/bundle.js`（esbuild）でデーモンを 1 ファイルにしたもの。依存（ws・zod・croner・Claude Agent SDK の JS）はすべて含む。`pnpm --filter @acc/daemon bundle` で単体でも作れる（`packages/daemon/dist/`）。

インストール後のアプリは、`get_connection` が `daemon.json` と `/health`（`service: "acc-daemon"` と `pid`）で既存のデーモンを確かめ、いなければ同梱の `acc-node.exe main.mjs` をコンソールなしの detach で起動する。`pnpm dev:daemon` や CLI で起動したデーモンがいればそれを使う。二重起動したアプリは既存のウィンドウを前に出して終わる。

**Claude Code（Agent SDK のランタイム）**：SDK の JS はバンドルに入るが、SDK 同梱の CLI（約 300MB の `claude.exe`）は入れない。デーモンは Run のたびに `ACC_CLAUDE_CODE_PATH` → バンドルの隣の `claude/claude.exe` → SDK のプラットフォーム別パッケージ（リポジトリ内の開発時）→ `PATH` の `claude.exe` → `~/.local/bin/claude.exe` の順に探して SDK に渡し、見つからなければ Worker の Run が日本語の理由つきで失敗する（`runtime/claude/locate.ts`）。版を揃えた CLI を同梱したいときは `node scripts/prepare-sidecar.js --release --with-claude-code` の後に `tauri build`（インストーラが 300MB 近く増える）。

Desktop UI（`apps/desktop`）：

```sh
pnpm --filter @acc/desktop scene        # 本物のデーモン + 本物の API で作る確認用の場面（一時 git リポジトリ、Worker、承認待ち、統合候補。ACC_PORT 既定 47899。--empty / --load 10）
pnpm --filter @acc/desktop tauri:dev    # Tauri アプリだけ（デーモンが無ければ tsx で detach 起動。普段は pnpm dev:desktop）
pnpm --filter @acc/desktop screenshots  # Playwright で主要画面を撮る（scene に対して。出力は OS の一時ディレクトリ。--theme light、--size 1100x720、--prefix、--only a,b）
pnpm --filter @acc/desktop e2e:slice    # 本物のデーモン + Vite を一時 ACC_HOME で起動し、オンボーディング → デモ → 送信 → 承認 → 統合の反映まで通す（--daemon-root で別チェックアウトのデーモンも使える）
pnpm --filter @acc/desktop e2e:board    # 本物のデーモンで Task ボード（T → j → R で Worker を起動）とパレットのメッセージ検索（session.search → 該当メッセージへ移動）を通す
pnpm --filter @acc/desktop e2e:conflict # 本物のデーモンで README.md がコンフリクトする統合を作り、レビュー画面の「Integrator に解消を任せる」→ 解消 → 反映待ちまで通す（main は動かないことも確かめる）
pnpm --filter @acc/desktop e2e:perf     # 本番ビルドで 10 本同時ストリーミングのフレーム間隔と長いタスクを測る（--profile で内訳、--dev で開発サーバ）
```

UI とデーモンは同じ `ACC_HOME` を見る（Vite の開発ミドルウェアが `daemon.json` を `/__acc/connection` で渡す）。scene は代役を使わず、すべて Control API を通して作るので、実際の挙動を隠さない。

### Vertical Slice を試す

- **オフライン（費用なし）**：UI の初回画面で「デモモードで試す」を選ぶ（または `system.setupDemo` を呼ぶ）。`<ACC_HOME>/demo/launch-demo` に git なしのフォルダと「デモ: 新製品ローンチ準備」（`mock/orchestrator` + `session.delegate`）ができるので、下書きの目標をそのまま送る。指揮役が 3 人に任せ、終わるたびに起こされて進み具合を答え、そろったら最終報告で止まる。コードの縦の流れ（Worker・統合・承認）は旧プリセットの `session.grantOrchestration` と `e2e:slice` で試す。
- **本物の経路**：設定（または `ACC_LITELLM_BASE_URL` / `ACC_LITELLM_API_KEY`）で LiteLLM Proxy の URL とキーを入れる。
  1. 自分のプロジェクトを追加し（`testCommand` を設定すると統合後に検証される）、チャットを作ってモデルに LiteLLM のモデル名（例 `claude-sonnet-4`）を選ぶ。
  2. そのチャットを `session.delegate({ sessionId })`（既定 4 人・$3）で指揮役にする。コードの Worker と統合の流れなら旧プリセットの `session.grantOrchestration({ sessionId, maxWorkers: 2 })`。
  3. Worker を Claude Code にするには `settings.update({ defaultRuntime: 'claude-agent-sdk' })`（Run ごとなら `task.spawnWorker` の `runtime`）。LiteLLM が設定されていれば SDK もそこを通り、なければ手元の Claude Code のログインを使う。SDK が読み込めないと Worker の Run は理由つきで失敗する。
  4. 費用が発生するのはこの経路だけ。テストでは呼ばない（下記 §6）。

## 2. パッケージ構成

```
packages/protocol   @acc/protocol  zod スキーマと型だけ。node の import 禁止（ブラウザでも使う）
  src/common.ts       ID・Timestamp・Actor・ページング
  src/domain.ts       Project / Workspace / Session / Message / Task / Run / Artifact /
                      Integration / Approval / CapabilityGrant / BudgetAllocation / Settings
  src/events.ts       eventPayloads（イベント型の唯一の定義）・Event・EventFilter・Delta
  src/api.ts          Control API 契約（メソッド → params / result / permission / description）
  src/method.ts       MethodDef と params ヘルパ（ext から使う）
  src/ext/<track>.ts  作り直しのトラックごとの型・メソッド・イベント（api.ts / events.ts が取り込む）
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

1. **契約**：`packages/protocol/src/api.ts` にエントリを足す（既にあれば不要。作り直しのトラックは `src/ext/<track>.ts` の `<track>Methods`）。
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
   - 会話に関わるメソッドは `scope` に `sessionIds` も返す（agent は自分の会話の木の中だけ）。
   - 契約だけ先に入れたメソッドは `stubMethod(name)` で登録しておく（`not_implemented`、ツール一覧と `system.info` には出ない）。実装を登録すると置き換わる。
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
- **テーブル / 絞り込み列**：モジュールの `migrations` に `{ id: '<module>/0002_xxx', sql }` を追加。出荷済みのマイグレーションは書き換えない。既存エンティティの列なら `core/repos.ts` の `columns` も足す。テーブルを作り直すもの（列の NOT NULL を外すなど。CREATE new → INSERT SELECT → DROP → RENAME → インデックス再作成）は `rebuildsTables: true` を付ける（既存の DB は適用前に `acc.sqlite.bak-<version>` に複製される）。
- **既存データの埋め直し**：冪等な処理はモジュールの `start` で毎回、一度だけのものは `runOnce(db, 'backfill/<module>/<name>', …)`（`core/backfills.ts`）。イベントは出さない。
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
- モジュールをまたぐ流れ（agent Run → コミット → Artifact → 統合、Task キャンセル → Run 停止）は `src/e2e.test.ts` が本物の全モジュールで確かめる。concept §12.1 の Vertical Slice 全体（WS + `@acc/client`、`mock/orchestrator`、並列 Worker、承認、統合、人間の承認、イベントの順序、失敗時の報告、同じファイルを触る 2 Task のコンフリクトを Integrator が解消する変種）は `src/e2e/vertical-slice.test.ts` が受け入れテスト。サービスを偽物に差し替えた単体テストでは継ぎ目の食い違いが見えないため、契約を変えたらここも通す。
- 時刻は `createManualClock()` を `createDaemon({ clock })` に渡して制御する。
- 再起動を伴うテストは `startTestDaemon({ home })` で同じ `ACC_HOME` を使い回す（例：`server.test.ts` のリカバリ、`orchestrator/resume.test.ts` の Orchestrator 再開）。
- 本物の有料 LLM API はテストで呼ばない。llm / runtime の mock を使う。
  - `d.ctx.service('llm').mock.chunkDelayMs = 0` で mock の送信間隔をなくす。台本は `mock.define('mock/x', scripted([{ text, toolCalls }, (req, info) => ({ text })]))`（`scripted` は `src/llm` から）。
  - LiteLLM 経路は `node:http` のローカル偽サーバに `settings.update({ litellm: { baseUrl } })` を向けて試す（例：`llm/llm.test.ts`、Orchestrator は `orchestrator/orchestrator.test.ts`）。Claude Agent SDK は `runtimes.get('claude-agent-sdk')` の `available` / `run` を spy して、選ばれることだけを確かめる。
- **Claude Agent SDK の契約テスト**（`runtime/claude/sdk-contract.test.ts`）：本物の SDK と SDK 同梱の本物の Claude Code CLI を、ローカルの偽 Anthropic API（`runtime/claude/contract/fakeAnthropic.ts`。SSE を本物と同じ形で返し、台本は受け取ったリクエストの関数）に向けて `ClaudeAgentSdkRuntime` を動かす。費用・ネットワーク・認証情報なし。CLI の HOME / `CLAUDE_CONFIG_DIR` / TEMP は一時ディレクトリで、`~/.claude` には触れない。環境変数は許可リストからだけ作る（開発機の `ANTHROPIC_*` は渡らない）。`HTTPS_PROXY` を「すべて拒否して記録する」プロキシに向け、偽 API 以外への接続がないことも確かめる。通常の `pnpm test` に含まれ（約 20 秒）、CLI のバイナリがなければ自動でスキップ、`ACC_SKIP_SDK_CONTRACT=1` でも飛ばせる。単体で回すときは `pnpm --filter @acc/daemon test:sdk-contract`。
  - 単体テスト（`runtime/claude.test.ts`）は、この CLI から**記録した**メッセージ列（`runtime/claude/contract/recorded.ts`）を再生する。手で書いた SDK メッセージは使わない。記録は `satisfies RecordedStream`（`contract/recordedTypes.ts`）で SDK の型に照らして型検査されるので、SDK の型が変わると typecheck で気づける。
  - **SDK を上げたら**：`pnpm --filter @acc/daemon record:sdk-fixtures` で記録し直し（パスは `<REPO>` などに置き換え、ダミーのトークン・ユーザー名・ローカルパスが残っていたら書き出さない）、`pnpm check` を通す。挙動の違いは契約テストが落ちて分かる。
- **本物の LiteLLM との契約テスト**（`llm/litellm-contract.test.ts`、任意）：本物の LiteLLM Proxy を `127.0.0.1` で起動し（`runtime/claude/contract/litellmProxy.ts`。ダミーのマスターキー、環境変数は許可リストだけ、`LITELLM_TELEMETRY=False`・`LITELLM_LOCAL_MODEL_COST_MAP=True`、外向きは拒否プロキシ）、上流を偽 Anthropic API に向けて、デーモンの LLM Gateway（`/chat/completions`）と Claude Agent SDK（`/v1/messages`）の両方を通す。費用なし。`ACC_LITELLM_BIN` が `litellm` の実行ファイルを指すときだけ動き、`pnpm check` では飛ばす。
  ```sh
  python -m venv <どこか>/litellm-venv && <どこか>/litellm-venv/Scripts/pip install "litellm[proxy]"   # macOS / Linux は bin/
  ACC_LITELLM_BIN=<どこか>/litellm-venv/Scripts/litellm.exe pnpm --filter @acc/daemon test:litellm-contract
  ```
  LiteLLM 1.106 の wheel には tiktoken の `cl100k_base` が入っておらず、オフラインだと起動後の最初の呼び出しがダウンロードを試みて 500 になる。そのときは `cl100k_base` のキャッシュ（ファイル名は URL の SHA-1 `9b5ad71b2ce5302211f9c61530b329a4922fc6a4`。tiktoken が SHA-256 を検証する）を置いたディレクトリを `ACC_LITELLM_TIKTOKEN_CACHE` で渡す（`CUSTOM_TIKTOKEN_CACHE_DIR` になる）。結果は `docs/snapshot/20261029_litellm-contract.md`。
- Run の Executor は `ctx.service('runs').registerExecutor(kind, fn)` で差し替えられる（後勝ち）。

## 7. 約束ごと

- UI・CLI の文言は日本語、コード・コメント・API の `description` は英語。
- API キー・トークンをイベント・ログ・API レスポンスに平文で出さない。
- `node:sqlite` の ExperimentalWarning は想定内（`main.ts` と vitest の `execArgv` で抑止済み）。
