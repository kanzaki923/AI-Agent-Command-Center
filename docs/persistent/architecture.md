# アーキテクチャ

構想は `concept.md`。この文書は「いまの実装がどういう形をしているか」と「守るべき契約」をまとめる。実装を変えたら同じコミットでここも直す。

## 1. 全体構成

```
apps/desktop      Tauri 2 + React UI（Core Daemon のクライアント）
packages/protocol ドメイン型・イベント型・Control API 契約（zod スキーマ）
packages/client   Control API の型付きクライアント（UI / CLI / テストが使う）
packages/daemon   Core Daemon（Node.js 22 常駐プロセス）
packages/cli      `acc` コマンド（Control API クライアント）
```

- pnpm workspace のモノレポ。内部パッケージは TS ソースを直接 export する（`exports` が `src/index.ts` を指す）。ビルドが必要なのは配布物（daemon バンドル、desktop）だけ。
- ランタイムは Node.js 22（Bun は Agent SDK 互換性・配布の検証が済むまで見送り）。
- 人間（UI / CLI）も LLM（Orchestrator / Worker）も、**同じ Control API ディスパッチャ**を通る。LLM 向けツールは API メソッド定義から自動生成し、Capability で絞り込む。

## 2. Core Daemon

### 2.1 起動と接続

- データディレクトリ：`ACC_HOME`（既定 `~/.acc`）。`acc.sqlite`、`config.json`（LiteLLM の URL / キーなど。リポジトリには置かない）、`worktrees/`、`daemon.json`（接続情報）。
- `127.0.0.1:47821`（`ACC_PORT` で変更）で待ち受け。HTTP `GET /health`、WebSocket `/ws?token=...`。
- 起動時にランダムトークンを生成し `daemon.json` に `{ port, token, pid, startedAt, version }` を書く（終了時に削除）。クライアントはこれを読んで接続する（同一ユーザー以外・ブラウザの任意ページからの操作を防ぐ）。同じ `ACC_HOME` で生きているデーモンがいれば 2 つ目は起動しない。
- 再起動時、`running` / `queued` / `awaiting_approval` のまま残った Run は `interrupted`（`statusReason: "daemon_restart"`）にし、イベントを残す。あわせてその Run の pending Approval を `cancelled`、ワークスペースロックと `session.activeRunId` を解放する（`core/recovery.ts`）。
- DB は Node 組み込みの `node:sqlite`（WAL）。ドライバは `core/db.ts` の `Db` インターフェースの裏に隠す。エンティティのテーブルは「絞り込み用のインデックス列 + `data`（エンティティ全体の JSON、読み書き時に zod で検証）」の形。フィールド追加にマイグレーションは要らず、絞り込み列を足すときだけ要る。
- `config.json` の設定（`Settings`）は `settings.get` / `settings.update` で読み書きする。API キーは API・イベント・ログに平文で出さない（`hasApiKey` / `apiKeyMasked` だけ返す）。環境変数 `ACC_LITELLM_BASE_URL` / `ACC_LITELLM_API_KEY` が設定値より優先される。

### 2.2 プロトコル（WebSocket 上の JSON-RPC 風）

```
→ { "id": 1, "method": "session.create", "params": {...} }
← { "id": 1, "result": {...} }   または   { "id": 1, "error": { "code": "...", "message": "..." } }
← { "type": "event", "subscriptionId", "event": Event }   // events.subscribe 後に push
← { "type": "delta", "subscriptionId", "delta": { runId, sessionId, messageId, kind, text, index } }
                                                          // ストリーミング断片（永続化しない）
```

- 契約は `packages/protocol/src/api.ts`（メソッド → params / result / permission / description）と `wire.ts`（封筒・エラーコード）が唯一の定義。params は strict（未知のキーは `invalid_params`）。
- エラーコード：`invalid_params` / `not_found` / `forbidden`（Capability 違反）/ `budget_exceeded` / `conflict`（ロック等）/ `limit_exceeded`（同時実行数・深さ）/ `internal`。契約にあるが未実装のメソッドは `not_found`（`data.reason: "not_implemented"`）。
- 取りこぼしのない購読：`events.subscribe` は購読時点のログ先頭 `lastSeq` を返し、それより後のイベントはすべて push される。再接続時、クライアントは再購読 → `events.list({ since: 最後に受けた seq })` で欠けを埋め、`seq` で重複を除く（`@acc/client` が自動で行う）。
- WebSocket 接続の Actor は `human`（`client` クエリでラベル付け）。LLM のツール呼び出しはデーモン内から `ctx.call(agentActor, ...)` で同じディスパッチャを通る。

### 2.3 モジュール

`packages/daemon/src/` 配下。各モジュールは自分のディレクトリに閉じ、`index.ts` で `defineModule({ name, migrations?, register(ctx) })` を export する。`register` で API メソッド・イベント購読・サービスを登録し、一覧は `src/modules.ts`。

- モジュール間の呼び出しはサービス経由：提供側が `ctx.provide('runs', impl)`（型は `Services` インターフェースへの declaration merging）、利用側は呼び出し時に `ctx.service('runs')`。
- マイグレーションはモジュールごとに持ち、ID を `<module>/0001_xxx` と名前空間で分ける（`core` → `modules.ts` 順に適用）。

| ディレクトリ | 責務 |
|---|---|
| `core/` | DB、マイグレーション、リポジトリ、Event Bus、ID、時刻、設定、起動時リカバリ、DaemonContext |
| `api/` | `defineMethod`・レジストリ、ディスパッチャ、PolicyEngine（既定実装）、WS/HTTP サーバ |
| `system/` | `system.*`、`settings.*` |
| `events/` | `events.list` / `subscribe` / `unsubscribe` |
| `projects/` | `project.*` |
| `policy/` | Capability Grant の評価・委譲制約、Budget（allocate / reserve / spend / release） |
| `llm/` | LLM Gateway（OpenAI 互換 `/chat/completions` ストリーミング → LiteLLM）、mock プロバイダ |
| `sessions/` | Session・Message・チャット Run |
| `runs/` | Run ライフサイクル、同時実行キュー、承認（Approval） |
| `runtime/` | Agent Runtime 抽象、Claude Agent SDK 実装、mock 実装 |
| `workspace/` | Git worktree の作成・ロック・diff・コミット |
| `tasks/` | Task・依存 DAG・スケジューラ |
| `orchestrator/` | LLM 向けツール生成、待機ツール、Orchestrator Run |
| `integration/` | 統合ブランチ、順次マージ、検証、承認後の反映 |

### 2.4 Control API と Capability

- params・result・`permission`（既定はメソッド名）・`description`（英語。LLM ツール説明にも使う）・`tool`（LLM に出してよいか）は protocol の `api` に宣言する。デーモン側は `defineMethod(name, { scope?, handler })` で実装だけを書く。
- ディスパッチャの順序：メソッド解決 → params 検証 → `scope` 解決 + `PolicyEngine.check(actor, permission, scope)` → handler → result 検証。
- 呼び出しには必ず `Actor` が付く：`human`（UI/CLI のトークン）、`agent`（`sessionId`, `runId`）、`system`。
- `human` / `system` は全権。`agent` は、その Run（`subject.kind = run`）またはその Session（`subject.kind = session`）に有効な Capability Grant が `permission`（`"*"`、`"task.*"` のようなパターン）と `scope` を許すときだけ実行できる。判定は**ディスパッチャで強制**し、ハンドラやプロンプトに任せない。
- scope：プロジェクトに関わるメソッドは `scope` で触るプロジェクトを返す。プロジェクト限定の Grant を持つ agent は、範囲外のプロジェクトや、プロジェクトを絞らない一覧（`session.list` で `projectId` なし等）を拒否される。`scope` を持たないメソッド（`system.*` 等）はプロジェクト制限の対象外。
- Grant の委譲：子 Grant の permissions・scope・limits は親の部分集合でなければ作れない。委譲深さは初期値 1（Orchestrator → Worker まで。Worker は Worker を起動できない）。
  - 判定は `policy/grants.ts`。agent が委譲するとき、親 Grant は (a) `grant.create`（Worker 起動時は `task.spawnWorker`）を持ち、(b) 子の各パターンを包含し（`"*"` ⊇ 全部、`"task.*"` ⊇ `"task.create"`）、(c) 子の projectIds ⊆ 親、(d) limits ≤ 親（`maxDepth` は 1 段ごとに 1 減る）、(e) `depth = 親.depth + 1 <= settings.maxDelegationDepth`。省略した scope・limits・`expiresAt` は親から引き継ぐ（広がらない）。
  - `limits.maxWorkers` は「その Run が起動し、まだ終わっていない子 Run（`parentRunId`）」の数で判定する（`policy.assertCanSpawnWorker`）。
- Grant の有効範囲：`run`（その Run の終了で失効）、`session`（期限 `expiresAt` まで）。Session に付けた `lifetime: run` の Grant は「そのセッションの次の Run が終わるまで」有効。剥奪は委譲先へ連鎖する。付与・剥奪は `grant.created` / `grant.revoked`、使用は `tool.called`、agent の拒否は `policy.denied` として残る。

### 2.5 Budget

- `BudgetAllocation` はツリー。`limitUsd`、`allocatedUsd`（子へ配分済み）、`reservedUsd`（実行中に確保）、`spentUsd`。
- 不変条件：`allocated + reserved + spent <= limit`。LLM 呼び出し前に見積額を reserve、完了で spend に確定、差額を解放。子の終了で未使用分を親へ返却。
- コストの出どころを `reported`（LiteLLM が返した値）/ `estimated`（トークン数×単価）/ `unknown` で区別する。
- 実装は `policy/budget.ts`（`ctx.service('budget')`）。金額は内部で整数マイクロドルとして扱い、検査と更新は 1 つの `BEGIN IMMEDIATE` トランザクションで行う（別接続からの同時予約でも超過しない）。予約は `budget_reservations` に永続化し、再起動時に未確定のものを取り消す。
- 返却：release は子孫から先に閉じ、空き（limit − allocated − reserved − spent）だけを親の `allocatedUsd` から減らす。消費済み分は親の `allocatedUsd` に残る。予約が残っている Budget は release できない（`conflict`）。実際の消費が予約を超えた場合は、消費の事実を優先して記録する（以後その Budget には空きがない）。
- agent が配分できるのは自分の Budget（自分の Run・Session・担当 Task が subject、または `run.budgetId`）からだけで、返却できるのは自分の Budget とその直下だけ。ルート Budget は人間だけが作る。

### 2.6 Run ライフサイクル

`created → queued → running → completed`。途中で `awaiting_approval`、終端は `completed / failed / cancelled / interrupted`。

- 同時実行数の上限（`settings.maxConcurrentRuns`、既定 10）を超えた Run は `queued` で待ち、空きができた順（FIFO）に始まる。実行枠は `running` と `awaiting_approval` が占有する（承認待ちもプロセスやロックを持ったままのため）。
- 1 つの worktree に書き込める Run は同時に 1 つ（ワークスペースロック）。ロック待ちの Run は `queued` のまま残り、後ろの Run は先に始まってよい。
- 1 セッションで同時に動く Run は 1 つ（2 つ目の `session.send` は `conflict`、ユーザーメッセージも残らない）。
- 実際の処理は Run の種類ごとの Executor（`ctx.service('runs').registerExecutor(kind, fn)`）が `RunController` 経由で行う（`chat` は sessions、`agent` は runtime、`orchestrator` は orchestrator）。終端状態は RunManager だけが決める。
- キャンセルは即座に `cancelled` にして signal を abort する。実行枠とロックは Executor が止まってから返す（止まらなければ 10 秒で強制解放）。デーモン停止時は `running` / `queued` を `interrupted`（`daemon_shutdown`）にする。
- 「いま何をしているか」は `Run.activity`。変化は `run.updated`（`changes: ["activity"]`）で届き、使用量の加算も `run.updated`（`["usage"]`）。activity は実行中だけ意味を持つ。
- Run 開始時に Capability と予算を評価し、終了時に予約と実行リソースを解放する。

### 2.6.1 LLM Gateway とチャット Run

- `ctx.service('llm')`：`mock/*` は組み込みの mock、それ以外は LiteLLM の `/chat/completions`（SSE ストリーミング、`stream_options.include_usage`）。設定は呼び出しごとに読む。
- コストの出どころ：ストリームの `usage.cost` > `x-litellm-response-cost` ヘッダ（ストリーミングで 0 のときは無視）を `reported`、単価表があれば `estimated`、なければ `unknown`。
- mock：`mock/echo`（実時間に近い間隔で分割送信）、`mock/fast`（遅延なし）。`llm.mock.define(model, scripted([...]))` でツール呼び出しを含む複数ターンの台本を定義できる（ターン = 最後のユーザーメッセージ以降のモデル呼び出し回数）。
- ツールループ `runToolLoop`（`src/llm`）：モデル → ツール呼び出し → ディスパッチャ経由で `ctx.call(run の agent actor, ...)` → 結果 → モデル…。ツールは API 契約（`tool !== false`）から生成し、actor の Grant で絞る。メソッド名の `.` はツール名では `__`。ツールの失敗は `{ error }` としてモデルに返し、Run は失敗させない。
- チャット Run はセッション履歴をそのまま送る。セッションに Grant があればその範囲の API がツールとして見える（普通のチャットが Orchestrator になれる）。モデル未設定かつ LiteLLM 未設定なら `mock/echo` を使う。
- `session.search`：FTS5 の trigram で部分一致（日本語向け）。3 文字未満の語は LIKE で補う。索引はトリガーで同期する。

### 2.7 イベント

全状態変化は `events` テーブルに追記し（単調増加 `seq`）、購読者へ配信する。UI の Timeline Mode と Orchestrator の状況判断はこれを読む。型は `packages/protocol/src/events.ts` の `eventPayloads` が唯一の定義。

- 封筒に `projectId / sessionId / runId / taskId` を持ち、絞り込みは payload を見ずに行える。`bus.emit` は payload の形（`{ run }`、`{ session }` 等）から参照を自動で埋める。
- `bus.emit` は呼び出し側のトランザクション内で追記し、**コミット後に**配信する（ロールバックされたイベントは誰にも届かない）。
- 状態を変えるメソッドは、同じトランザクションで「エンティティ更新 + イベント追記」を行う。`*.updated` には変わったフィールド名を `changes` に入れる。

### 2.8 Workspace と Integration

- **Workspace**：worktree は `<ACC_HOME>/worktrees/<projectId>/<workspaceId>`、ブランチは既定 `acc/<slug>-<id末尾8文字>`（slug はラベルかタスク名の ASCII 部分、なければ `ws`）。リポジトリ本体は `kind: main` のワークスペースとして初回参照時（`workspace.list` で projectId 指定など）に登録し、削除できない。git は `workspace/git.ts` の `git(cwd, args)` で引数配列のまま spawn する（シェルを通さない）。
- **ロック**：書き込める Run は 1 つ。Run のロックはメモリ + `Workspace.lockedByRunId`（再起動時に `core/recovery.ts` と workspace モジュールの `start` が終わった Run のロックを外す）。統合など daemon 内部の作業は `hold()` でメモリだけのロックを取る。ロック中は削除不可。
- **削除**：`workspace.remove` は worktree だけ消してブランチは必ず残す（成果物を失わない）。未コミットの変更があると `force` なしでは拒否。
- **diff**：`baseRef`（既定はワークスペースの baseRef）と HEAD の merge-base に対し、コミット済み・未ステージ・未追跡をすべて含めて出す。未追跡は一時 index（`GIT_INDEX_FILE`）に `add -A` して拾い、エージェントの index は触らない。パッチは 2M 文字で切る（ファイル別統計は完全）。
- **コミット**：`commitAll` の author/committer は `Project.commitAuthor`、未設定なら `AI Agent Command Center <acc@localhost>`。
- **Artifact**：`ctx.service('artifacts')` の `record` / `recordDiff` / `recordCommit` / `recordTestResult` で記録し `artifact.created` を出す。projectId・taskId はワークスペースや Run から補う。
- **Integration**：`integration.create` で反映先（既定 `Project.defaultBranch`）から `acc/integration-<id末尾8文字>` を専用 worktree に作り、merge ×N → verify → apply の手順を `pending` で並べる。`integration.run` はすぐ返し、裏で毎回反映先の最新から `git merge --no-ff` を順に行い、`Project.testCommand` をシェルで実行する（タイムアウト既定 10 分、出力は末尾 64KiB を test_result Artifact に、`ACC_*` 環境変数は渡さず `CI=true`）。手順ごとに `integration.updated` を出す。
  - 状態：`running` → `verifying` → `awaiting_approval`（反映待ち）／`conflict`（マージ中止済み、統合ブランチは直前の状態）／`failed`（テスト失敗・その他）。`conflict` / `failed` / `awaiting_approval` からは再実行できる。同じプロジェクトの統合と承認は 1 件ずつ直列に実行する。
  - `integration.approve` は **human のみ**（agent・system は Grant があっても `forbidden`、LLM ツールにも出さない）。反映は早送りだけ：反映先がどこかの作業ツリーでチェックアウト中なら、そこが clean のときだけ `merge --ff-only`（dirty なら `conflict`）、どこにもチェックアウトされていなければ旧値つき `update-ref`。反映先が進んでいたら `conflict`（再実行を促す）。
  - 却下・失敗でも worktree とブランチは残す。再起動で中断された統合は `failed`（`daemon_restart`）になる。

### 2.9 Task と依存 DAG

- `dependsOn` は同じプロジェクトの既存 Task だけ。未知の ID・循環は `invalid_params`。
- 依存待ちの Task（`pending` / `ready` / 依存による `blocked`）の状態はデーモンが自動で保つ：依存がすべて `done` → `ready`、依存が `failed` / `cancelled` / `blocked` → `blocked`（`statusReason: dependency_failed | dependency_cancelled | dependency_blocked`）、解消すれば `pending` / `ready` に戻る。`dependency_*` 以外の `blocked`（人間待ちなど）は自動では戻さない。
- 状態変更は `ctx.service('tasks').setStatus(...)` に集約し、依存先への波及も同じトランザクションで `task.updated` を出す。キャンセルはサブタスクと実行中の Run にも及ぶ。

## 3. Desktop UI

- Tauri 2 のシェルは Core Daemon を起動（未起動なら）して接続情報をフロントへ渡すだけ。ロジックは持たない。
- ブラウザ（`pnpm dev`）でも同じ UI が動く（Vite の開発ミドルウェアが `daemon.json` を渡す）。E2E テストはこの経路で行う。
- 状態：サーバ状態は TanStack Query、イベントストリームで無効化・差分反映。UI 状態は Zustand。
- 3 モード：Command（要対応を優先した俯瞰）/ Focus（1 セッション集中）/ Timeline（イベント時系列）。コマンドパレットとキーボード操作を一級に扱う。
