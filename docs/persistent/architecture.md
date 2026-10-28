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
- Grant の有効範囲：`run`（その Run の終了で失効）、`session`（期限 `expiresAt` まで）。付与・使用・剥奪はイベントとして残る。

### 2.5 Budget

- `BudgetAllocation` はツリー。`limitUsd`、`allocatedUsd`（子へ配分済み）、`reservedUsd`（実行中に確保）、`spentUsd`。
- 不変条件：`allocated + reserved + spent <= limit`。LLM 呼び出し前に見積額を reserve、完了で spend に確定、差額を解放。子の終了で未使用分を親へ返却。
- コストの出どころを `reported`（LiteLLM が返した値）/ `estimated`（トークン数×単価）/ `unknown` で区別する。

### 2.6 Run ライフサイクル

`created → queued → running → completed`。途中で `awaiting_approval`、終端は `completed / failed / cancelled / interrupted`。

- 同時実行数の上限（既定 10）を超えた Run は `queued` で待つ。
- 1 つの worktree に書き込める Run は同時に 1 つ（ワークスペースロック）。
- Run 開始時に Capability と予算を評価し、終了時に予約と実行リソースを解放する。

### 2.7 イベント

全状態変化は `events` テーブルに追記し（単調増加 `seq`）、購読者へ配信する。UI の Timeline Mode と Orchestrator の状況判断はこれを読む。型は `packages/protocol/src/events.ts` の `eventPayloads` が唯一の定義。

- 封筒に `projectId / sessionId / runId / taskId` を持ち、絞り込みは payload を見ずに行える。`bus.emit` は payload の形（`{ run }`、`{ session }` 等）から参照を自動で埋める。
- `bus.emit` は呼び出し側のトランザクション内で追記し、**コミット後に**配信する（ロールバックされたイベントは誰にも届かない）。
- 状態を変えるメソッドは、同じトランザクションで「エンティティ更新 + イベント追記」を行う。`*.updated` には変わったフィールド名を `changes` に入れる。

### 2.8 Agent Runtime（`runtime/`）

コーディングエージェントの実行基盤。契約は `contracts.ts` の `AgentRuntime` / `AgentEvent` / `RuntimesService`。

- `ctx.service('runtimes')` に `mock`（オフライン、既定）と `claude-agent-sdk` を登録する。既定は `settings.defaultRuntime`（未登録の名前なら `mock`）。Run が使うのは `run.runtime` → `session.runtime` → 既定の順。
- `agent` 種別の RunExecutor（`createAgentExecutor`）：ワークスペースのパスで Runtime を動かし、`AgentEvent` を `RunController` に流す。プロンプトは Task（目標・完了条件）＋起動メッセージ。終了時に `workspaces.commitAll`、`artifacts` サービスがあれば diff Artifact を記録する。
- **ツール権限は `policy.ts` の純関数で決める**（プロンプトに任せない）：読み取り系はワークスペース内なら許可、編集系もワークスペース内なら許可（worktree が隔離されており、統合前に diff を確認するため）、コマンド（Bash / PowerShell）と、ワークスペース外のパスに触れるもの、未知のツールは承認（`tool_use` の Approval）。
- Claude Agent SDK：SDK は遅延 import（読み込めなくてもデーモンは起動し、`available()` が理由を返す）。`permissionMode: 'default'` と `settingSources: []` を明示し、ユーザー / リポジトリの設定ファイルの allow ルールや hooks を効かせない（そのためリポジトリの CLAUDE.md は読まない）。子プロセスの環境は許可リストで組み立てる（`env.ts`。値はログに出さない）。LiteLLM の URL があれば `ANTHROPIC_BASE_URL` / `ANTHROPIC_AUTH_TOKEN` / モデルを渡し、なければユーザーの Claude Code ログインをそのまま使う。
- 再開：Runtime 自身のセッション ID を `runtime_sessions`（Session × Runtime）に保存し、次の Run に渡す（`Session.runtimeSessionId` にも反映）。SDK の使用量は SDK セッション単位の累積値なので、`runtime_usage_baselines` との差分を Run の使用量として報告する。
- mock：プロンプト中の ` ```acc-mock ` JSON ブロック（`mock/plan.ts`。`say` / `write` / `append` / `run` / `ask` / `check` / `sleep` / `fail`）に従ってワークスペースを実際に変更する。ブロックがなければ `notes/<タスク名>.md` を作って確認する。デモと E2E はこれを使う。

## 3. Desktop UI

- Tauri 2 のシェルは Core Daemon を起動（未起動なら）して接続情報をフロントへ渡すだけ。ロジックは持たない。
- ブラウザ（`pnpm dev`）でも同じ UI が動く（Vite の開発ミドルウェアが `daemon.json` を渡す）。E2E テストはこの経路で行う。
- 状態：サーバ状態は TanStack Query、イベントストリームで無効化・差分反映。UI 状態は Zustand。
- 3 モード：Command（要対応を優先した俯瞰）/ Focus（1 セッション集中）/ Timeline（イベント時系列）。コマンドパレットとキーボード操作を一級に扱う。
