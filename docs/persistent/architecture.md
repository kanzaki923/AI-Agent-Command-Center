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
- `127.0.0.1:47821`（`ACC_PORT` で変更）で待ち受け。HTTP `GET /health`（認証なし。`{ ok, service: "acc-daemon", pid, version, protocolVersion }`。ランチャーは `service` と `pid` で自分のデーモンか確かめる）、WebSocket `/ws?token=...`。
- 起動時にランダムトークンを生成し `daemon.json` に `{ port, token, pid, startedAt, version }` を書く（終了時に削除）。クライアントはこれを読んで接続する（同一ユーザー以外・ブラウザの任意ページからの操作を防ぐ）。WebSocket の upgrade は `Origin` も確かめ、デスクトップ（`tauri://localhost` / `http(s)://tauri.localhost`）とループバックの開発サーバ、`Origin` なし（CLI 等）だけを通す。
  - トークンは同じ OS ユーザーのプロセスなら読める。エージェントの書いたコード（Worker のテストやビルド、統合のテスト）は同じユーザーで動くので、トークンを読んで「human だけ」の操作（`integration.approve`、Grant、設定など）を人間として呼べる。字面の規則（§2.10）・環境変数の許可リスト・`Origin` の検査はこれを防げず、承認の数を増やしても塞がらない（Worker がコマンドを動かした時点で開いている）。根本対策は OS レベルの隔離（エージェントを `ACC_HOME` を読めない別の権限で動かす。未対応）で、それまでは後から見える記録（`tool.decided`）で補う（UI 以外の接続からの `integration.approve` を目立たせる監査は未対応）。同じ `ACC_HOME` で生きているデーモンがいれば 2 つ目は起動せず exit 0 で終わる（同時起動で bind に負けた側も、勝者の `daemon.json` を確かめて exit 0。ランチャーは exit 0 を「他が担当」とみなして勝者に接続する。ポートを別のプログラムが使っていれば exit 1）。
- 停止は `system.shutdown`（人間だけ。`tool: false`。実行中の Run があれば `force` なしでは `conflict`）。応答を返してからサーバ・モジュール・DB を閉じ、`daemon.json` を消してプロセスを終える（`ctx.requestShutdown()` → `Daemon.closed`）。CLI は `acc daemon stop`。
- 再起動時、`running` / `queued` / `awaiting_approval` のまま残った Run は `interrupted`（`statusReason: "daemon_restart"`）にし、イベントを残す。あわせてその Run の pending Approval を `cancelled`、ワークスペースロックと `session.activeRunId` を解放する（`core/recovery.ts`）。その後の各モジュールの照合（中断された Worker の Task、統合、Orchestrator の再開）は §2.8・§2.12。
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
| `orchestrator/` | Orchestrator Run、Worker の起動と追従（`task.spawnWorker`）、待機（`task.wait` / `integration.wait`）、`mock/orchestrator`、デモモード |
| `integration/` | 統合ブランチ、順次マージ、検証、承認後の反映 |

### 2.4 Control API と Capability

- params・result・`permission`（既定はメソッド名）・`description`（英語。LLM ツール説明にも使う）・`tool`（LLM に出してよいか）は protocol の `api` に宣言する。デーモン側は `defineMethod(name, { scope?, handler })` で実装だけを書く。
- ディスパッチャの順序：メソッド解決 → params 検証 → `scope` 解決 + `PolicyEngine.check(actor, permission, scope)` → handler → result 検証。
- 呼び出しには必ず `Actor` が付く：`human`（UI/CLI のトークン）、`agent`（`sessionId`, `runId`）、`system`。
- `human` / `system` は全権。`agent` は、その Run（`subject.kind = run`）またはその Session（`subject.kind = session`）に有効な Capability Grant が `permission`（`"*"`、`"task.*"` のようなパターン）と `scope` を許すときだけ実行できる。判定は**ディスパッチャで強制**し、ハンドラやプロンプトに任せない。
- scope：プロジェクトに関わるメソッドは `scope` で触るプロジェクトを返す。プロジェクト限定の Grant を持つ agent は、範囲外のプロジェクトや、プロジェクトを絞らない一覧（`session.list` で `projectId` なし等）を拒否される。`scope` を持たないメソッド（`system.*` 等）はプロジェクト制限の対象外。
- Grant の委譲：子 Grant の permissions・scope・limits は親の部分集合でなければ作れない。委譲深さは初期値 1（Orchestrator → Worker まで。Worker は Worker を起動できない）。
  - 判定は `policy/grants.ts`。agent が委譲するとき、親 Grant は (a) `grant.create`（Worker 起動時は `task.spawnWorker`）を持ち、(b) 子の各パターンを包含し（`"*"` ⊇ 全部、`"task.*"` ⊇ `"task.create"`）、(c) 子の projectIds ⊆ 親、(d) limits ≤ 親（`maxDepth` は 1 段ごとに 1 減る）、(e) `depth = 親.depth + 1 <= settings.maxDelegationDepth`。省略した scope・limits・`expiresAt` は親から引き継ぐ（広がらない）。
  - `limits.maxWorkers` は Grant の subject ごとに「起動して、まだ終わっていない子 Run（`parentRunId`）」の数で判定する（`policy.assertCanSpawnWorker`）。subject が Session なら、そのセッションのどの Run が起動した子も数える（先の Orchestrator Run が終わっても、残った Worker は枠を使い続ける）。
- agent が `task.spawnWorker` / `task.retry` 以外で Run を始められるのは（`session.send`・`run.retry`）、自分が作ったチャットセッション（`parentSessionId` = 自分のセッション）で、Session Grant を持たないものだけ（`policy.assertAgentMayStartRun`）。強いセッションをその Grant と予算で動かしたり、Worker を委譲・上限の外で増やしたりさせない。
- セッションのワークスペースと Task は、セッションにプロジェクトがあればそのプロジェクトのものに限る（`session.create` / `session.update`。移動でずれる場合も拒否）。
- LLM に見せるツールの一覧づくりは呼び出しではないので、外したメソッドを `policy.denied` に記録しない（`PolicyEngine.peek`）。
- Grant の有効範囲：`run`（その Run の終了で失効）、`session`（期限 `expiresAt` まで）。Session に付けた `lifetime: run` の Grant は「そのセッションの次の Run が終わるまで」有効（クラッシュで中断された Run も同じ：起動時のスイープが、Grant の後に終わった Run があるセッションの `lifetime: run` Grant を失効させる）。剥奪は委譲先へ連鎖する。付与・剥奪は `grant.created` / `grant.revoked`、使用は `tool.called`、agent の拒否は `policy.denied` として残る。
- Control API の Capability とは別に、エージェントの**ツールの使用**（ファイル・コマンド・Web）はデーモンの権限ゲートが決める（§2.10）。どこまで任せるか（`Project.permissionProfile`、`settings.defaultPermissionProfile` / `autoMode`、覚えた許可 `permissionRule.*`、`approval.respond` の `remember`）を変えられるのは人間だけ（agent が `project.update` で `permissionProfile` を変える、`remember` を付けて回答するのは Grant があっても `forbidden`）。

### 2.5 Budget

- `BudgetAllocation` はツリー。`limitUsd`、`allocatedUsd`（子へ配分済み）、`reservedUsd`（実行中に確保）、`spentUsd`。
- 不変条件：`allocated + reserved + spent <= limit`（例外は下記の「消費の事実を優先」）。LLM の 1 回の呼び出し（chat / orchestrator Run）は reserve → settle（差額を解放）、事後にしかわからない消費（Agent Runtime）は `recordSpend`（§2.6）。子の終了で未使用分を親へ返却。
- コストの出どころを `reported`（LiteLLM が返した値）/ `estimated`（トークン数×単価）/ `unknown` で区別する。
- 実装は `policy/budget.ts`（`ctx.service('budget')`）。金額は内部で整数マイクロドルとして扱い、検査と更新は 1 つの `BEGIN IMMEDIATE` トランザクションで行う（別接続からの同時予約でも超過しない）。予約は `budget_reservations` に永続化し、再起動時に未確定のものを取り消す。
- 返却：release は子孫から先に閉じ、空き（limit − allocated − reserved − spent）だけを親の `allocatedUsd` から減らす。消費済み分は親の `allocatedUsd` に残る。予約が残っている Budget、終わっていない Run が `budgetId` に持つ Budget は release できない（`conflict`）。返却済みの Budget で Run は始められない。実際の消費が予約を超えた場合は、消費の事実を優先して記録する（以後その Budget には空きがない）。
- agent が配分できるのは自分の Budget（自分の Run・Session・担当 Task が subject、または `run.budgetId`）からだけで、返却できるのは自分の Budget とその直下だけ。ルート Budget は人間だけが作る。

### 2.6 Run ライフサイクル

`created → queued → running → completed`。途中で `awaiting_approval`、終端は `completed / failed / cancelled / interrupted`。

- 同時実行数の上限（`settings.maxConcurrentRuns`、既定 10）を超えた Run は `queued` で待ち、空きができた順（FIFO）に始まる。実行枠は `running` と `awaiting_approval` が占有する（承認待ちもプロセスやロックを持ったままのため）。ただし agent の Run が `task.wait` / `integration.wait` で眠っている間は、その枠を待ち行列に貸す（`runs.lendSlot`。待っている Worker が始まれずに止まらないように）。待ちから戻った Run は、枠が埋まっていても続ける（一時的に上限を超えうる）。
- 1 つの worktree に書き込める Run は同時に 1 つ（ワークスペースロック）。ロック待ちの Run は `queued` のまま残り、後ろの Run は先に始まってよい。ワークスペースが `removed` / `error` になった Run は待たずに `failed`（`workspace_unavailable`）。
- 1 セッションで同時に動く Run は 1 つ（2 つ目の `session.send` は `conflict`、ユーザーメッセージも残らない）。
- `run.retry`：Task の Worker（`agent` で `taskId` あり）は `task.retry` として行う（Task の状態・権限・上限・予算の規則がそのまま効く）。Integrator の Run は再試行できない（統合から改めて Integrator に任せる）。
- 実際の処理は Run の種類ごとの Executor（`ctx.service('runs').registerExecutor(kind, fn)`）が `RunController` 経由で行う（`chat` は sessions、`agent` は runtime、`orchestrator` は orchestrator）。登録は各モジュールの `start()` で行う。終端状態は RunManager だけが決める。
- `agent` Run で `workspaceId` を省くと、セッション → Task のワークスペースを Run に記録してそのロックを取る（Executor が書き込む先と、ロックの対象を一致させる）。`chat` Run はロックを取らない。
- キャンセルは即座に `cancelled` にして signal を abort する。実行枠とロックは Executor が止まってから返す（止まらなければ 10 秒で強制解放。強制解放の後で確定した LLM 呼び出しの実費も、Run の使用量と Budget に記録する）。デーモン停止時は `running` / `queued` を `interrupted`（`daemon_shutdown`）にする。
- 「いま何をしているか」は `Run.activity`。変化は `run.updated`（`changes: ["activity"]`）で届き、使用量の加算も `run.updated`（`["usage"]`）。activity は実行中だけ意味を持つ。
- 予算（Budget を持つ Run）：
  - LLM 呼び出しの前に `ctl.reserveBudget()` で `settings.llmCallReserveUsd`（既定 $0.25）を予約し、終わったら `hold.settle(usage)` で実額に確定、失敗した呼び出しは `hold.cancel()`。予約が入らない（空き < 予約額）呼び出しは拒否するので、同じ Budget を共有する Run が同時に動いても、1 回の実額が予約額以下である限り上限を超えない（`runToolLoop` が使う）。Run の終了時に残った予約は取り消す。
  - Agent Runtime は使用量を事後に `reportUsage` で報告し、そのたびに `recordSpend` する。始める前に空きがなければ（または返却済みなら）`ctl.assertBudgetLeft()` で拒否する。消費を Budget に記録できなかった Run は、上限なしに続けさせず予算切れとして止める（使用量は Run に残る）。
  - 残り（limit − allocated − reserved − spent）が 0 以下になった Run、予約できずに拒否された Run は `failed`（`statusReason: budget_exhausted`、エラー `budget_exceeded`）。
- 終了時に実行枠とロックを返し、その Run に紐づく `lifetime: run` の Grant は policy モジュールが失効させる（`grant.revoked`）。

### 2.7 イベント

全状態変化は `events` テーブルに追記し（単調増加 `seq`）、購読者へ配信する。UI の Timeline Mode と Orchestrator の状況判断はこれを読む。型は `packages/protocol/src/events.ts` の `eventPayloads` が唯一の定義。

- 封筒に `projectId / sessionId / runId / taskId` を持ち、絞り込みは payload を見ずに行える。`bus.emit` は payload の形（`{ run }`、`{ session }` 等）から参照を自動で埋める。
- `bus.emit` は呼び出し側のトランザクション内で追記し、**コミット後に**配信する（ロールバックされたイベントは誰にも届かない）。
- 配信は `seq` 順を保つ：コミット後フック（`Db.afterCommit`）は登録順に 1 本のキューで実行し、フックの中で別のトランザクションがコミットしても、そのフックは残りの後ろに並ぶ（例：トランザクション内で `runs.start` した Run の起動イベントが、同じトランザクションで後から出したイベントより先に届かない）。クライアントは `seq` で重複を除くため、順序が崩れると欠けて見える。
- 状態を変えるメソッドは、同じトランザクションで「エンティティ更新 + イベント追記」を行う。`*.updated` には変わったフィールド名を `changes` に入れる。

### 2.8 Workspace と Integration

- **Workspace**：worktree は `<ACC_HOME>/worktrees/<projectId>/<workspaceId>`、ブランチは既定 `acc/<slug>-<id末尾8文字>`（slug はラベルかタスク名の ASCII 部分、なければ `ws`）。リポジトリ本体は `kind: main` のワークスペースとして初回参照時（`workspace.list` で projectId 指定など）に登録し、削除できない。git は `workspace/git.ts` の `git(cwd, args)` で引数配列のまま spawn する（シェルを通さない）。worktree の中身はエージェントが書くので、デーモンの git はリポジトリ由来のプログラムを実行しない：毎回 `-c core.fsmonitor=false -c core.hooksPath=<null デバイス>`（コミット・マージは `--no-verify` も）、環境は許可リスト（`runtime/env.ts` + `GIT_CONFIG_*`）。linked worktree の `.git` ファイルは、作業ツリーの外の `<common>/worktrees/<name>` を指し、その `gitdir` が戻ってくるときだけ使い、`GIT_DIR` / `GIT_WORK_TREE` で固定する（書き換えられていれば git を実行せずエラー）。
- **ロック**：書き込める Run は 1 つ。Run のロックはメモリ + `Workspace.lockedByRunId`（再起動時に `core/recovery.ts` と workspace モジュールの `start` が終わった Run のロックを外す）。統合など daemon 内部の作業は `hold()` でメモリだけのロックを取る。ロック中は削除不可。
- **削除**：`workspace.remove` は worktree だけ消してブランチは必ず残す（成果物を失わない）。未コミットの変更があると `force` なしでは拒否。ロックの確認と同時に（await の前に）自分でロックを取るので、削除の途中で Run が始まって作業ディレクトリを消されることはない。
- **diff**：`baseRef`（既定はワークスペースの baseRef）と HEAD の merge-base に対し、コミット済み・未ステージ・未追跡をすべて含めて出す。未追跡は一時 index（`GIT_INDEX_FILE`）に `add -A` して拾い、エージェントの index は触らない。パッチは 2M 文字で切る（ファイル別統計は完全）。
- **コミット**：`commitAll` の author/committer は `Project.commitAuthor`、未設定なら `AI Agent Command Center <acc@localhost>`。
- **Artifact**：`ctx.service('artifacts')` の `record` / `recordDiff` / `recordCommit` / `recordTestResult` で記録し `artifact.created` を出す。projectId・taskId はワークスペースや Run から補う。
- **Integration**：`integration.create` で反映先（既定 `Project.defaultBranch`）から `acc/integration-<id末尾8文字>` を専用 worktree に作り、merge ×N → verify → apply の手順を `pending` で並べる。`integration.run` はすぐ返し、裏で毎回反映先の最新から `git merge --no-ff` を順に行い、`Project.testCommand` をシェルで実行する（タイムアウト既定 10 分、出力は末尾 64KiB を test_result Artifact に。環境はエージェントと同じ許可リスト + `CI=true`。出力に LiteLLM のキーやデーモンのトークンがあれば `[REDACTED]` にする）。
  - テストはエージェントの書いたコードをユーザーの権限で動かす。**慎重プロファイル（§2.10）では**、人間が始めていない試行（agent の `integration.run`、Integrator の解消後の再開など）は、実行の前に `integration` 種別の Approval（`payload: { action: "verify", command }`、`integrationId` つき、`runId` なし）を出して待つ（状態は `verifying` のまま。回答できるのは人間だけで、agent・system からは Grant があっても `forbidden`。却下は `failed`（`tests_not_approved`）、停止・再起動で待ちが切れたら取り消す。UI は統合のカードで尋ねる）。標準・おまかせでは待たない：Worker がすでに同じコードを同じユーザー・同じ環境で承認なしに動かしているので、ここで止めても守れるものが増えないため（§2.1）。手順ごとに `integration.updated` を出す。
  - 状態：`running` → `verifying` → `awaiting_approval`（反映待ち）／`conflict`（マージ中止済み、統合ブランチは直前の状態）／`failed`（テスト失敗・その他）。`conflict` / `failed` / `awaiting_approval` からは再実行できる。同じプロジェクトの統合と承認は 1 件ずつ直列に実行する。承認（反映）の途中は、`integration.run` / `reject` / `resolveWithAgent` / 二重の承認を `conflict` にする（呼び出した時点で反映中の印を付ける）。順番待ちの試行は、始まる時点で `running` でなければ何もしない。
  - テストコマンドの終了はシェルの `exit` で決める。残ったバックグラウンドプロセスが出力のパイプを持ち続けても、1 秒待ってパイプを閉じて終える（POSIX はプロセスグループごと止める）。
  - `integration.approve` は **human のみ**（agent・system は Grant があっても `forbidden`、LLM ツールにも出さない）。反映は早送りだけ：反映先がどこかの作業ツリーでチェックアウト中なら、そこが clean のときだけ `merge --ff-only`（dirty なら `conflict`）、どこにもチェックアウトされていなければ旧値つき `update-ref`。反映先が進んでいたら `conflict`（再実行を促す）。
  - 却下・失敗でも worktree とブランチは残す。再起動で中断された統合は `failed`（`daemon_restart`）になる。
  - **Integrator**（concept §6.1 の 5）：`integration.resolveWithAgent({ integrationId, instructions? })` は `conflict` の統合だけ。統合用 worktree にコンフリクトしたマージを再現し（マーカー入り）、コンフリクトしたマージの直後に `fix` 手順を挟んで状態を `running` にしてから（`integration.wait` は待ち続ける）、その worktree で `agent` Run（Task なし。権限・深さ・予算は Worker と同じ規則で `orchestrator/workers.ts` が起動）を始め、`Integration.resolverRunId` に記録する。プロンプトはコンフリクトしたファイルと両側の Task の目標・完了条件・要約（`acc-mock` 計画は渡さない）。Run が `completed` で、マージがコミット済み（`MERGE_HEAD` なし）・未解決ファイルなし・取り込むブランチが HEAD に含まれる・マーカーが残っていない、を確かめたら **再開モード**で続ける：統合ブランチを作り直さず、すでに含まれるソースは「取り込み済み」とし、残りのマージと検証を行う。満たさなければ worktree を再現前に戻して `conflict`（`error.code: resolution_failed`、理由つき）。通常の `integration.run` は反映先から作り直すので `fix` 手順と解消結果は消える。
- **Project の検査**：`project.inspectRepo({ path })`（`tool: false`、読み取りだけ）は、絶対パスか・存在するか・git リポジトリのルートか（サブフォルダならルートを `repoRoot` で示す）を日本語の `reason` つきで返し、`defaultBranch`（origin/HEAD → main / master → 現在のブランチ）、`currentBranch`、`isDirty`、`suggestedName`（フォルダ名）、`suggestedTestCommand`（package.json の `test` スクリプト + lockfile で pnpm / yarn / bun / npm、Cargo、Go、pytest）、登録済みなら `existingProjectId` を返す。UI が `project.create` の前に呼ぶ。

### 2.9 Task と依存 DAG

- `dependsOn` は同じプロジェクトの既存 Task だけ。未知の ID・循環は `invalid_params`。
- 依存待ちの Task（`pending` / `ready` / 依存による `blocked`）の状態はデーモンが自動で保つ：依存がすべて `done` → `ready`、依存が `failed` / `cancelled` / `blocked` → `blocked`（`statusReason: dependency_failed | dependency_cancelled | dependency_blocked`）、解消すれば `pending` / `ready` に戻る。`dependency_*` 以外の `blocked`（人間待ちなど）は自動では戻さない。
- 状態変更は `ctx.service('tasks').setStatus(...)` に集約し、依存先への波及も同じトランザクションで `task.updated` を出す。キャンセルは未完了のサブタスク（`parent_cancelled`）と、それらの終わっていない Run にも及ぶ（コミット後に `runs.cancel`、`statusReason: task_cancelled`）。

### 2.10 Agent Runtime

コーディングエージェントの実行基盤。契約は `contracts.ts` の `AgentRuntime` / `AgentEvent` / `RuntimesService`。

- `ctx.service('runtimes')` に `mock`（オフライン、既定）と `claude-agent-sdk` を登録する。既定は `settings.defaultRuntime`（未登録の名前なら `mock`）。Run が使うのは `run.runtime` → `session.runtime` → 既定の順。
- `agent` 種別の RunExecutor（`createAgentExecutor`）：ワークスペースのパスで Runtime を動かし、`AgentEvent` を `RunController` に流す。プロンプトは Task（目標・完了条件）＋起動メッセージ。終了時に `workspaces.commitAll` し、変更があれば `artifacts.recordDiff` で diff Artifact を記録する（失敗しても Run は失敗させない）。
- **ツール権限は層に分けてデーモンが決める**（プロンプトに任せない。目標は「安全で、承認依頼 0」。承認は決められないときの妥協。経緯は `docs/snapshot/20261029_auto-mode.md`）。Run ごとの `ToolGate`（`runtime/gate.ts`）が、すべてのランタイム（claude・mock）で上から順に評価する：
  1. **絶対ルール**（`policy.ts` / `commandPolicy.ts`、全プロファイル共通）：承認にせず拒否し、代わりにどうするかを日本語＋英語の理由でエージェントに返す（エージェントは別の手段を取るか、最終報告に書く）。`.git` の改ざん（パスに `.git` を含む編集、`git config` の書き込み・`update-ref`・`worktree`・`--git-dir`）、worktree の外への書き込み（字面と実パス。`cd ..` の後のコマンドも）、資格情報とデーモンのデータ（`~/.ssh`・`~/.aws`・`~/.claude`・gh / npm の認証・`ACC_HOME` と他の worktree）、push・publish・リモートの変更（`git push`・`git remote add`・`gh pr create`・`npm publish`・`docker push` など）、他のブランチへの切り替え・ブランチの削除、データを送る通信（`curl -d/-F/-T/-X POST`・`ssh`・`scp`・`rsync` でリモートへ）、システムの変更と Run の外に残るプロセス（`sudo`・グローバルなインストール・`git config --global`・末尾 `&`・`nohup`・コンテナ・サービス・`kill`）、自己昇格（`claude` など別のエージェント CLI、Control API のポート、`.claude/settings*.json`）、ダウンロードして実行（`curl … | sh`、`iex (iwr …)`）、中身を確かめられないもの（`-EncodedCommand`）、無人に合わないツール（`DISALLOWED_AGENT_TOOLS`）。コマンドは `runtime/shell.ts` で分解し（`;` `&&` `|`、リダイレクト、`$(…)`、`bash -c` / `sh -c` / `cmd /c` / `powershell -Command` の中、`node -e` などのインラインコードの字面も）、部分ごとに判定する。字面しか見えないので、テストやインストールスクリプトの中の操作は防げない（§2.1）。
  2. **覚えた許可**：人間が承認のときに `remember`（`run` / `task` / `project`）を付けると `permission_rules`（`runtime/rules.ts`）に残り、一致する以後の使用は承認なしで許可（`decidedBy: remembered`）。一致は同じツールで、コマンドなら全部分の「プログラム＋サブコマンド」（`pnpm add`、`curl`）が規則の集合に入ること（インタプリタはスクリプトまで：`node scripts/test.js`。`node -e` や `python -c` など、スクリプトより前にフラグがあるものは覚えない）、外の読み取りならそのディレクトリ以下。何を覚えるかはツールの承認の `payload.rememberAs`（覚えられないなら `null`）で、人間が範囲を選ぶ前に見せる。絶対ルールは越えられない。Run / Task 単位の規則はその Run / Task の使用にだけ効く。`permissionRule.list` / `permissionRule.revoke`、`permission.rule_created` / `permission.rule_revoked`。
  3. **グレーゾーン**：Claude Code の auto mode が使えるときはその分類器に任せ（下記）、使えないときはプロファイルの表（`policy.ts` の `GRAY`）で決める。プロファイルは `Project.permissionProfile`（null なら `settings.defaultPermissionProfile`、既定 `autonomous`）を Run の開始時に解決する。

     | 種類 | おまかせ（autonomous） | 標準（standard） | 慎重（careful） |
     |---|---|---|---|
     | worktree 内の読み取り・編集、読み取りだけのコマンド、作業管理・Control API・サブエージェント | 許可 | 許可 | 許可 |
     | テスト・ビルド・scripts、ローカルの git、マニフェストからの依存インストール、読み取りだけの通信（WebFetch・`git fetch`・`curl` の GET）、その他の worktree 内のコマンド | 許可 | 許可 | 承認 |
     | 新しい依存の追加（`pnpm add x`、`npx`） | 許可（`notable`） | 承認 | 承認 |
     | worktree の外の読み取り、未知のツール | 拒否（理由つき） | 承認 | 承認 |
  4. **承認**（`tool_use` の Approval）は上で決まらなかったものだけ。おまかせでは起きない（統合の反映だけが人間の判断）。
  - 「読み取りだけのコマンド」は狭い許可リスト（`runtime/commands.ts`）：プログラムが `ls` / `cat` / `head` / `tail` / `wc` / `grep` / `rg` / `find`（判定条件だけ）/ `git status|diff|log|show|ls-files|rev-parse|branch|blame` のいずれかで、フラグは各プログラムの読み取り専用の許可リストにあるものだけ（`find -delete`、`git diff --output`、`git -c …` は不可）、引数のパスはすべてワークスペース内。`&&` などでつないだ部分がすべてこれなら全体もこれ。
  - 「ワークスペース内」は字面と実パス（シンボリックリンク・ジャンクションを解決。まだないパスは存在する最も深い祖先を解決して残りを足す）の両方で判定する。リポジトリにコミットされたリンクから外へ出る書き込みは拒否、読み取りは外の読み取りになる。OS の一時ディレクトリも外（他のプログラムのファイルがある。一時ファイルは worktree の中に作らせる）。`/dev/null` は可。
- 承認の payload は `ToolApprovalPayload` `{ toolName, input, risk, category?, reason? }`（`category` は上の種類、`reason` は自動で決めなかった理由）。`risk`（`low` / `medium` / `high`）はデーモンが決める（`runtime/risk.ts`）：`rm -rf`・`git push`・`git reset --hard`・ネットワークからのインストールやダウンロード・`sudo` などのコマンドとワークスペース外への編集は `high`、それ以外のコマンド・外の読み取り・Web・未知のツールは `medium`、ワークスペース内の読み書きは `low`。
- **判断の記録**：ゲートの判断は 1 回のツール使用につき 1 回、`RunController.recordToolDecision` で記録する。worktree 内の読み取り・編集・読み取りだけのコマンドなどの日常的な許可は `Run.toolDecisions`（`{ allowed, denied, asked }`、`run.updated` `["toolDecisions"]`、1 秒ごとにまとめて更新）に数えるだけ。それ以外（すべての拒否・承認・覚えた許可・分類器の判断・コマンドなど）は `tool.decided`（`{ runId, toolCallId, toolName, summary, decision: allowed|denied|asked, decidedBy: rule|remembered|classifier|runtime|human, rule, category, reason, profile, notable }`、actor は `system` / `permissions`）。Run の判断の仕方は `Run.permission`（`{ profile, gate: classifier|rules, note }`、途中で規則に落ちたら `run.updated` `["permission"]`）。
- Claude Agent SDK：SDK は遅延 import（読み込めなくてもデーモンは起動し、`available()` が理由を返す）。`settingSources: []` を明示し、ユーザー / リポジトリの設定ファイルの allow ルールや hooks を効かせない（そのためリポジトリの CLAUDE.md は読まない）。`permissionMode` は auto mode を使うとき `auto`、それ以外は `default`。子プロセスの環境は許可リストで組み立てる（`env.ts`。値はログに出さない）。LiteLLM の URL があれば `ANTHROPIC_BASE_URL` / `ANTHROPIC_AUTH_TOKEN` / モデルを渡し、なければユーザーの Claude Code ログインをそのまま使う。どちらでも `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1`（1 Run = 1 ターンなので、サブエージェントやコマンドをバックグラウンドに回させない。サブエージェントは終わるまで Agent ツールが待つ）。
  - **権限は `PreToolUse` フックで強制する**：CLI は読み取り系の Bash（`git status` など）、`Monitor`、`CronCreate`、`EnterWorktree` などを `canUseTool` を呼ばずに自動で許可する（実機で確認。`docs/snapshot/20261029_agent-sdk-real-cli.md`）。フックはすべてのツール呼び出し（サブエージェントのものも）でゲートを通し、拒否は `deny`（理由がモデルに届く）、承認は `ask`（CLI が `canUseTool` を呼び、同じ tool use id には同じ答えを返して Approval に回す）、許可なら何も返さない。`allowedTools` は使わない（`canUseTool` を素通りさせるため）。拒否するツールは `disallowedTools` でモデルのツール一覧からも外す。
  - **auto mode**（`settings.autoMode.enabled`、慎重以外のプロファイル）：判定する場所は `settings.autoMode.judge`。**`server`（既定）**は Anthropic の API が本体のリクエスト（`safeguards`）でツール使用を判定し、別リクエストも分類器の費用もない（LiteLLM を素通しで動く。上流が Anthropic API のとき）。ユーザーの Claude ログインでも LiteLLM 経由でも、分類器のモデルなしで auto にする。`CLAUDE_CODE_AUTO_MODE_SERVER` は設定しない（CLI の既定）。上流が判定を返さない（`safeguard_results` がない・`unsupported`）と CLI はそのセッションの残りを手元の分類器で判定する：`settings.autoMode.classifierModel` があれば `CLAUDE_CODE_AUTO_MODE_MODEL` に渡してその予備に使い、なければ CLI の既定名で頼み、それも答えられなければ下の「判定できない」で規則に切り替わる。**`client`** は CLI が分類器へ別リクエストを送る（`CLAUDE_CODE_AUTO_MODE_SERVER=0`。1 回約 $0.01、キャッシュが冷えると約 $0.13。`docs/snapshot/20261029_auto-mode-cost.md`）。モデルは `classifierModel`（LiteLLM で Claude Sonnet 5 を指す名前）、空なら CLI の既定（Claude Sonnet 5。Sonnet 5.5 / Opus 5.5 を指定しても CLI は Sonnet 5 で判定する）。LiteLLM にそのモデルがなければ「判定できない」で規則に切り替わる。どちらの判定にもインライン設定 `autoMode`（`$defaults` ＋ Worker の環境の説明と絶対ルールの言い換え、`classifyAllShell`。`claude/runtime.ts` の `AUTO_MODE_SETTINGS`）が届く（サーバー判定では `safeguards[].classifier_context.auto_mode` に入る。偽 API での観察で、文書にはない）。`AUTO_MODE_SETTINGS` には Run ごとの文字列（パス・ID）を入れない：手元の分類器のプロンプトの先頭が全 Worker で同じになり、プロンプトキャッシュを共有できる。フックは絶対ルールなら `deny`、覚えた許可・自前のツール（`mcp__acc__*` など）なら `allow`、プロファイルが承認・拒否とするものはそのとおり、残りは**何も返さず分類器に任せる**（`allow` / `ask` は分類器を飛ばすため）。分類器の判断は `system/permission_denied` と `tool_result_meta`（文書なし、任意扱い）から `tool.decided`（`decidedBy: classifier`）にし、判定した場所が分かるときは `judge`（`stream_event` の `message_delta.delta.safeguard_results` がそのツール使用を評価していれば `server`、`client` 設定か CLI がサーバー判定をやめたのを見た後なら `client`、分からなければ付けない）。`Run.permission.judge` は使っている判定の場所で、サーバー判定をやめたのを見たら `client` と `note` に理由。分類器が同じ操作を止め続けて CLI が `canUseTool` を呼んだら、おまかせは「要確認」（`notable`）の拒否、標準は承認。`system/init` が `auto` でない（対応しないモデル）とき、分類器が「判定できない」と拒否したとき（`could not evaluate`・`cannot determine the safety`・`Classifier unavailable`・`non_execution_kind: automode-unavailable`）は、その Run を規則に切り替え（`setPermissionMode('default')`、以後の許可はフックで明示）、`Run.permission.note` に理由を出す。手元の分類器の費用は SDK の使用量に入らない（Budget は少なく数える。未対応）。
  - 停止：中断は `interrupt()` → 入力を閉じる → 猶予（既定 5 秒）後に `close()`。CLI から何も届かない時間が `idleTimeoutMs`（既定 10 分。承認待ちの時間は数えない）を超えたら止めて失敗にする。in-process MCP のツールが `system/init` に出ていなければ、日本語の理由で Run を失敗させる。認証エラー（401 など）は CLI が 10 回まで再試行するが、最初の再試行で止める。
  - 失敗の理由は assistant の `error`（`SDKAssistantMessageError` の全値）→ `terminal_reason` → result の subtype の順に日本語にし、`api_error_status` と CLI の詳細を添える（LiteLLM が包んだエラー文は上流のメッセージだけにし、LiteLLM にないモデル（400）はそう説明する。§2.11）。
- **Control API ツール**：Executor は Run の Grant が許すメソッド（`apiTools`。Orchestrator が起動した Worker なら読み取りのプリセット、人間が起動した Run は Grant がないのでなし）を `AgentRunInput.tools` で渡す。Claude ランタイムはこれを in-process MCP サーバ `acc`（`createSdkMcpServer`、`claude/mcp.ts`）にし、ツール名は `mcp__acc__task_get` のようにメソッドの `.` を `_` にしたもの、入力スキーマは契約の params。呼び出しはディスパッチャを Run の agent actor で通る（Grant 外は `forbidden` をツールのエラーとして返す）ので、ポリシーは `mcp__acc__*` を許可する（承認なし）。
- 再開と費用：Runtime 自身のセッション ID を `runtime_sessions`（Session × Runtime）に保存し、次の Run に渡す（`Session.runtimeSessionId` にも反映）。SDK の使用量は SDK セッション単位の累積値（再開すると CLI が transcript に保存した累計から続く）なので、`runtime_usage_baselines` との差分を Run の使用量として報告する。基準値は result を受け取った時点で保存する（その時点で CLI は累計を保存済み。直後に強制終了しても二重計上にならない）。ただし累計が全部 0 のエラー result（起動直後の中断など）では基準値を変えない。費用は CLI の価格表による見積もりなので `costSource: 'estimated'`、CLI が価格を知らないモデル（gateway の別名など。`costBasis: 'unknown'`）なら `'unknown'`。ストリーム途中で中断した API 呼び出しは CLI 自身が数えないため、どこにも計上されない。
- mock：プロンプト中の ` ```acc-mock ` JSON ブロック（`mock/plan.ts`。`say` / `write` / `append` / `run` / `ask` / `check` / `sleep` / `fail` / `resolve`）に従ってワークスペースを実際に変更する。ツールの使用は本物と同じゲートを通り、承認になったものは `onReject`、拒否されたものは理由をツールのエラーとして返して `onDeny`（既定 `continue`：本物のエージェントのように続ける）に従う。`ask` は常に人間に尋ねる（承認 UI の確認用）。ブロックがなければ、マージ中の未解決ファイルがあれば `resolve`（各コンフリクトを ours + theirs の順に連結）、なければ `notes/<タスク名>.md` を作って確認する。デモと E2E はこれを使う。

### 2.11 LLM Gateway とチャット Run

- `ctx.service('llm')`：`mock/*` は組み込みの mock、それ以外は LiteLLM の `/chat/completions`（SSE ストリーミング、`stream_options.include_usage`）。設定は呼び出しごとに読む。
- コストの出どころ：ストリームの `usage.cost` > `x-litellm-response-cost` ヘッダ（ストリーミングで 0 のときは無視）を `reported`、単価表があれば `estimated`、なければ `unknown`。本物の LiteLLM はストリームの最後の usage チャンクに `cost`（LiteLLM の価格表による。キャッシュの読み書きも含む）を入れ、ストリームではヘッダを送らない。`prompt_tokens` はキャッシュの読み書きを含む。
- 無応答：LiteLLM は止まった上流のストリームを自分のタイムアウト（既定 6000 秒）まで開いたままにするので、Gateway が LiteLLM から何も届かない時間（応答ヘッダ待ちを含む）を `idleTimeoutMs`（既定 5 分）で打ち切り、`llm_timeout` で失敗させる。
- エラー：LiteLLM は上流のエラーを `litellm.XxxError: AnthropicException - b'{...}'` ＋「LiteLLM: model group … No fallback was attempted.」で包む。`llm/gatewayErrors.ts` で上流のメッセージだけを取り出し、HTTP ステータスごとの日本語の説明を付ける（Claude ランタイムの失敗理由も同じ関数を使う）。LiteLLM にないモデルは 404 ではなく 400「Invalid model name passed in model=…」なので `llm_model_not_found` にする。上流の 401 / 404 の後、LiteLLM はそのデプロイメントを数秒止め、次の呼び出しは上流に届かず 429（`all_deployments_in_cooldown`）になる。429 / 5xx は LiteLLM が再試行する（既定で計 3 回）ので、Gateway は再試行しない。
- Anthropic の extended thinking：LiteLLM は thinking を `reasoning_content` と `thinking_blocks`（署名つき）で流す。thinking が有効なモデルでは、ツール呼び出しのターンを thinking ブロックなしで送り返すと Anthropic が 400 を返すので、ツールループはそのターンの `thinking_blocks` を次の呼び出しの assistant メッセージに付けて返す（メモリ上だけ。セッション履歴には保存しない）。
- mock：`mock/echo`（実時間に近い間隔で分割送信）、`mock/fast`（遅延なし）。`llm.mock.define(model, scripted([...]))` でツール呼び出しを含む複数ターンの台本を定義できる（ターン = 最後のユーザーメッセージ以降のモデル呼び出し回数）。
- ツールループ `runToolLoop`（`src/llm`）：モデル → ツール呼び出し → ディスパッチャ経由で `ctx.call(run の agent actor, ...)` → 結果 → モデル…。ツールは API 契約（`tool !== false`）から生成し、actor の Grant で絞る。メソッド名の `.` はツール名では `__`。ツールの失敗は `{ error }` としてモデルに返し、Run は失敗させない。
- チャット Run はセッション履歴をそのまま送る。セッションに Grant があればその範囲の API がツールとして見える（普通のチャットが Orchestrator になれる）。モデル未設定かつ LiteLLM 未設定なら `mock/echo` を使う。
- `session.search`：FTS5 の trigram で部分一致（日本語向け）。3 文字未満の語は LIKE で補う。索引はトリガーで同期する。
- Session 自身の Budget（subject `session`、`active`）があれば、`session.send` の Run はそれを `budgetId` にする。

### 2.12 Orchestrator と Worker

Orchestrator は**セッション種別ではなく役割**（concept §3.1）。チャットに Grant を与えると、そのチャットが他のエージェントを率いる。

- **付与**：`session.grantOrchestration({ sessionId, projectId?, maxWorkers=2, lifetime='run', budgetUsd?, expiresAt? })`（人間だけ）。プリセット `ORCHESTRATOR_PERMISSIONS`（`task.*`、session / run / workspace / artifact / approval / events の読み取り、`run.cancel`、`integration.create/run/resolveWithAgent/get/list/wait`、`orchestrator.*`、`project.get`）を、そのプロジェクト限定・`limits { maxWorkers, maxDepth: 1 }` で付ける。`integration.approve`・`grant.*`・`budget.*`・設定は含めない。`budgetUsd` はセッションのルート Budget になる。
- **Run 種別**：`session.send` はセッションの Grant が `task.spawnWorker` を許すとき Run を `orchestrator` にする。Executor（`orchestrator/executor.ts`）はチャットと同じツールループに、役割・プロジェクト（`projectId: ...`）・上限を書いた短い system prompt を前置きし、ツールは同じ API 契約とディスパッチャから作る。ターン上限は 80。
- **`task.spawnWorker`**：`ready` / `failed` / 人間待ちの `blocked` の Task だけ。`policy.assertCanSpawnWorker`（権限・プロジェクト・`maxWorkers`・深さ）→ worktree（Task に既にあれば再利用、なければ Task 名で作成）→ Worker セッション（`agent`、`parentSessionId` = 呼び出し元、Task・ワークスペース付き）→ `agent` Run（`parentRunId` = 呼び出し元の Run、`runtime` は指定 → `settings.defaultRuntime` → `mock` を解決して記録）→ Task を `running`（`assigneeSessionId`・`workspaceId`）。worktree 作成以外は 1 トランザクションで、上限の判定から Run 開始まで await を挟まない。
  - agent が呼ぶと、Worker の Run に委譲 Grant（既定 `WORKER_DEFAULT_PERMISSIONS` = Task / ワークスペース / Artifact の読み取りを親が持つ範囲で、`lifetime: run`、`limits { maxWorkers: 0, maxDepth: 0 }`）を付ける。Worker は Worker を起動できず、Grant も作れない。
  - 予算：呼び出し元の Run に Budget があれば、そこから `budgetUsd`（省略時は空き ÷（残りの Worker 枠 + 1）。1 つ分は呼び出し元が自分の LLM 呼び出しのために残す）を切り出して Worker セッションの Budget にする。
- **`task.retry({ taskId, feedback?, integrationId? })`**：元の Worker に差し戻す。「元の Worker」は担当セッションのうち、その Task のために作られ（`session.taskId`）、同じプロジェクトで、Session Grant を持たない `agent` セッションだけ（それ以外なら新しい Worker を起動する）。前の Run の Budget を使い続けるのも、それがそのセッションに切り出したものであるときだけ。agent は `task.update` で担当セッションをその Task のセッション以外に向けられない（別プロジェクトのセッションは誰でも不可）。`review` / `failed` / `ready` / 人間待ちの `blocked` の Task で、Worker セッションと worktree が残っていれば、そのセッションに差し戻しメッセージ（指摘＋ `integrationId` があればその統合のエラー・テストコマンド・出力の末尾 4000 文字）を足し、同じ worktree・ブランチで新しい `agent` Run（`retryOfRunId` = 前の Run、Runtime は自分のセッションを再開）を始めて Task を `running` にする。権限・上限・委譲 Grant は spawn と同じで、Budget は前の Run のものがまだ有効なら使い続ける。Worker が一度もいない Task は `task.spawnWorker` と同じ（指摘は追加の指示になる）。
- **Worker の終了**（`run.status_changed` の終端を orchestrator モジュールが購読）：その Task を担当中（`running` かつ担当セッション）なら、`completed` → `review`（変更なしは `statusReason: no_changes`、`resultSummary` に最後の発言）、`failed` / `cancelled` → `failed`（`worker_failed` / `worker_cancelled`）、`interrupted`（デーモンの停止・再起動）→ `ready`（`statusReason: interrupted`。`task.retry` で同じ worktree から再開できる）。worktree とブランチは残す。人間がキャンセルした Task などはそのまま。起動時にも同じ照合をする。
- **Orchestrator の再開**（concept §8.4、`orchestrator/resume.ts`）：起動時（全モジュールの start の後）、`daemon_restart` / `daemon_shutdown` で `interrupted` になり、まだセッションの最新 Run である `orchestrator` Run ごとに、そのセッションへ system メッセージ（`ORCHESTRATOR_RESUME_NOTICE` で始まり、中断した Run の ID・そのセッションが作った Task と統合の状態）を 1 回だけ投稿する。`settings.autoResumeOrchestrators`（既定 true）かつセッションの Orchestrator Grant がまだ有効なら、そのメッセージを起点に新しい `orchestrator` Run を始める（`lifetime: run` の Grant は中断で失効しているので、通知だけになる）。モデルは `task.list` で状態を読み直し、中断された Task を `task.retry` で再開して計画を続ける。
- **待機**：`task.wait({ taskIds, mode: any|all, until: settled|review_or_terminal|terminal, timeoutMs })` は状態を確かめてから `bus.waitFor` で眠り（ポーリングしない）、`call.signal` で打ち切る。返すのは `reached`（ID）と全 Task の `TaskSnapshot`（状態・理由・ブランチ・最新 Run と activity・承認待ち数・diff 統計・要約）。`integration.wait` は統合が `awaiting_approval` / `conflict` / `failed` / 確定状態になるまで待つ。LLM のループは「spawn → task.wait(all) → integration.create → run → integration.wait → 報告」だけで済む。
- **判断の記録**：`orchestrator.decision` イベント。LLM は `orchestrator.recordDecision` で残し、デーモンも自分の判断（Worker を起動した・Task をレビュー待ち / 失敗にした）を `system` actor で残す。参照は呼び出し元（Orchestrator）のセッションと Run に付ける。
- **`mock/orchestrator`**（`orchestrator/mockModel.ts`）：ツール結果だけを見て次の手を決める決定的なモデル。目標 → `task.create` ×2（ドキュメントとテスト、完了条件と mock Worker 用の `acc-mock` 計画つき。テスト側はテストを実行し、続く `git push` は絶対ルールで拒否されて、理由を読んでコミットだけして終える。おまかせでは統合の反映まで承認は 0。慎重ではテストの実行が承認になり、却下されたら失敗）→ `task.spawnWorker` ×2 → `task.wait` → `integration.*` → 日本語の報告。途中で失敗があれば統合せず報告する。統合が `conflict` なら `integration.resolveWithAgent` を 1 回だけ呼んで待ち直し、まだ `conflict` なら人間に相談する。テスト失敗では `task.retry`（`integrationId` つき）を対応案として示す。再開メッセージの後は `task.list` → 中断 Task の `task.retry` → 通常の流れ（作成済みの統合があれば作り直さず `integration.run`）。目標に「README」を含むと両 Task が README.md に追記する（コンフリクトの再現用）。本物のモデルと同じツールしか使わない。
- **デモモード**：`system.setupDemo({ name='auth-demo' })`（冪等）。`<ACC_HOME>/demo/<name>` に `node --test` が通る小さな Node プロジェクトの git リポジトリを作り、プロジェクト（`testCommand: node --test`）と、`mock/orchestrator` の「デモ: 設計チャット」に `lifetime: session` の Orchestrator 権限を用意する。UI の「デモモードで試す」がこれを呼び、目標を下書きに入れてチャットを開く。

## 3. Desktop UI

- Tauri 2 のシェルは Core Daemon を起動（未起動なら）して接続情報をフロントへ渡すだけ。ロジックは持たない。
  - `get_connection`（`src-tauri/src/daemon.rs`）：`daemon.json` + `/health`（`service`・`pid` 一致）で既存デーモンを再利用、なければ detach 起動（Windows は `CREATE_NO_WINDOW | CREATE_NEW_PROCESS_GROUP`、可能なら `CREATE_BREAKAWAY_FROM_JOB`）して `daemon.json` を待つ。UI を閉じてもデーモンは残る。起動に失敗したら今回の起動ログの末尾を日本語のメッセージに付けて UI に返す。
  - 起動方法：`tauri dev` は `node --import tsx packages/daemon/src/main.ts`、ビルド済みアプリは同梱の `acc-node.exe`（固定版の公式 Node）+ `resources/daemon/main.mjs`（esbuild の 1 ファイル）。`ACC_DAEMON_ENTRY` で差し替え可能。
  - single-instance（2 つ目の起動は既存ウィンドウを前面に）、window-state（位置・大きさ・最大化を復元。表示は最初のページ読み込み後）、notification（OS 通知。capability は `is_permission_granted` / `request_permission` / `notify` だけ。UI は `lib/notify.ts` から直接 invoke）、枠なし + HTML のタイトルバー。
  - アプリを開いたまま `system.shutdown` すると、UI の再接続でシェルが新しいデーモンを起動する。だから UI の停止ボタンはデスクトップアプリでは `再起動` と呼ぶ。
  - Claude Code の CLI は同梱しない。デーモンが実行ファイルを探して Agent SDK に渡す（`runtime/claude/locate.ts`、見つからなければ理由つきで Run が失敗）。
- ブラウザ（`pnpm dev`）でも同じ UI が動く（Vite の開発ミドルウェアが `daemon.json` を渡す）。E2E テストはこの経路で行う。`/__acc/connection` は同じオリジンのページ（`Sec-Fetch-Site: same-origin`、`Origin` が自分）か、ブラウザ以外からの要求だけに答え（`scripts/same-origin.js`）、dev / preview サーバの CORS は切る（ほかのローカルポートのページにトークンを読ませない）。
- 状態：サーバ状態は TanStack Query、イベントストリームで無効化・差分反映。UI 状態は Zustand。
- 3 モード：Command（要対応を優先した俯瞰）/ Focus（1 セッション集中）/ Timeline（イベント時系列）。コマンドパレットとキーボード操作を一級に扱う。
