# 2026-10-29 構造の作り直し：仕様（実装トラックが従う契約）

入力：`source-vision.md`（ユーザー指摘と 5 秒テスト）、`20261029_gap-audit.md`、concept.md、architecture.md、protocol と daemon の現物。
この文書は「決定」を書く。理由は 1 行まで。迷ったときの優先順位は **5 秒テスト ＞ 破綻しない ＞ 汎用 ＞ 既存コードの温存**。

---

## 0. 決定の要約

| # | 決定 | リードの方針からの差分 |
|---|---|---|
| D1 | ユーザーに見せる名詞は **会話・エージェント・成果物・出番** の 4 つだけ。Run / Task / Grant / worktree / Integrator / Daemon は API とコードには残すが、UI に出さない | そのまま |
| D2 | すべては **会話の木**。`Session.parentSessionId` を軸に `rootSessionId` を持たせ、木の単位で状態・費用・出番をまとめる | そのまま |
| D3 | 子は `chat`（普通の会話）か `agent`（自律して作業）。agent の作業場所は **なし／フォルダ／git worktree** の 3 択。「なし」は daemon が用意する専用の作業フォルダ（scratch）で実装する | 補足：Agent SDK は cwd が必須なので「なし」＝ユーザーが選ばない scratch フォルダ |
| D4 | プロジェクトは git 不要。`repoPath`（コード）と `folderPath`（普通のフォルダ）はどちらも任意 | そのまま |
| D5 | 作業の完了＝**子が成果物を残して終わったこと**。成果物を明示しなかった子は、最後の回答を文書の成果物として daemon が自動で残す。git の統合・テスト・反映は「コード」の任意の工程 | 補足：非コードの成果物は既定で人の確認を要求しない（出番を増やさない）。確認が要るのはコードの反映と、依頼者が `reviewBy: human` を付けたものだけ |
| D6 | **出番（Attention）を daemon の一級エンティティにする**。種類は `question / approval / failure / review / budget / stuck`。UI は 1 行＋ボタンで描けるよう、daemon が `title` と `choices` を作る | 追加：失敗・予算切れ・ループも同じ出番に載せる |
| D7 | 人への質問は `human.ask`。**どのランタイムでも非ブロッキング**（質問を出して返る。答えはその会話へのメッセージとして届き、新しい実行が始まる） | 補足：ブロッキングにすると MCP のタイムアウトと再起動で答えを失うため |
| D8 | 指揮役（Supervisor、内部名 orchestrator）は **イベント駆動**。1 回の実行は「計画・指示して返事をしたら終わる」。子の完了・失敗・出番、質問への答え、ユーザーの発言で daemon が起こす。`task.wait` / `integration.wait` は LLM のツールから外す | そのまま |
| D9 | ユーザーのメッセージは **拒否しない**。指揮役と普通の会話は「実行中なら次の区切り（ツール結果の後）で差し込む」、エージェントは「今の実行の後に回す（キュー）」。エージェントだけは明示の「割り込む」で今の実行を止めて即座に渡せる | 選択：区切りで差し込む（指揮役・会話）＋キュー（エージェント） |
| D10 | 親を止めると子孫も止まる（`session.stop` の既定は木ごと）。止めた状態は終端ではなく `paused`（再開できる） | そのまま |
| D11 | 無限ループは daemon が止める：1 実行のモデル呼び出し上限、同じツール呼び出し／同じ本文の 3 連続、1 時間あたりの起床回数の上限。モックの指揮役は「最終報告にはツール呼び出しを付けない」状態機械に書き直す | そのまま |
| D12 | AI は普通の会話も子として起こせる（`session.spawn` `mode: chat`）。権限（同時の子の数）と予算の範囲内 | そのまま |
| D13 | 費用は **すべての使用を台帳（usage ledger）に記録**する。実行中も推定値を積み、終了時に確定値へ差し替える。会話・木・日・プロジェクト・モデルの集計はここから出す。1 日の上限は台帳で強制する | 補足：日次上限は予算ツリーの根ではなく台帳で強制（日をまたぐ予算ノードを作らないため） |
| D14 | 子の未使用予算は、子の作業が終わった時点で自動で親へ戻す。子の超過は親へ伝播する | そのまま |
| D15 | 定期実行は **会話に付く**。発火のたびにその会話の **子の会話を 1 つ作る**（追記はしない）。スリープ等で逃した回は「直近の 1 回だけ、遅延の上限内なら起動時に実行」。過去分をまとめて走らせない | 選択：子を作る方式に一本化 |
| D16 | ホーム画面のデータは `home.get` 1 回で取れる。「いま何してる」は daemon がツール・状態から作る短い名詞句（LLM を呼ばない）。所要時間の予測は出さず、経過時間と次回の予定時刻だけ | そのまま |
| D17 | 指揮役の権限の既定の有効期間は `session`（取り消すまで）。旧 `run` は新設の `work`（その木の作業が落ち着くまで）として扱う。daemon の再起動では失効しない | 変更：既定 `run` では再起動後に再開できない（gap-audit）ため |
| D18 | 同時実行枠を 2 系統に分ける：エージェント（workspace を持つ）と LLM だけの実行（会話・指揮役）。指揮役がエージェントに枠を占有されて応答できない状態をなくす | 追加 |
| D19 | 維持：LiteLLM 経由、ToolGate／絶対ルール／auto mode、コード用の worktree、人間と LLM が同じ Control API を使うこと | そのまま |

---

## 1. ドメインモデル

### 1.1 会話（Session）— 変更

既存フィールドはそのまま。以下を足す（すべて既定値付き。古い行もそのまま読める）。

```ts
Session += {
  rootSessionId: SessionId,          // 木の根（根は自分自身）。列 root_session_id
  state: SessionState,               // daemon が維持（§3.7）。列 state。既定 'idle'
  stateSince: Timestamp | null,      // 経過時間の基準
  now: string | null,                // 「いま何してる」名詞句（最大 24 文字）。実行中だけ
  cost: { ownUsd: number; treeUsd: number; source: CostSource }, // 既定 0 / unknown
  brief: SessionBrief | null,        // 子が受けた依頼（依頼カードとして固定表示）
  scheduleId: ScheduleId | null,     // 定期実行の発火で作られた子
  supervision: 'active' | 'paused',  // 指揮役の起床の可否（止めたら paused）。既定 'active'
}
SessionState = 'idle' | 'queued' | 'working' | 'supervising' | 'needs_you'
             | 'failed' | 'review' | 'done' | 'stopped'
SessionBrief = { goal: string; doneWhen: string[]; fromSessionId: SessionId | null;
                 reviewBy: 'none' | 'human'; givenAt: Timestamp }
```

- `kind` は `chat | agent` のまま（意味だけ変える：agent ＝ Agent Runtime で自律的に作業。コーディングに限らない）。
- 役割（UI のアイコン）は導出：委任の権限（§1.8）を持つ → `supervisor`、それ以外は `kind`。
- 状態の優先順位（§3.7 の導出規則）：`needs_you > failed > working > supervising > queued > review > stopped > done > idle`。

### 1.2 実行（Run）— 変更

```ts
Run += {
  trigger: 'user' | 'wake' | 'spawn' | 'schedule' | 'resume' | 'retry' | 'system', // 既定 'user'
}
RunStatus  // 変更なし。新しい statusReason / error.code：
           // 'turn_limit' | 'loop_detected' | 'superseded'（割り込みで止めた）| 'stopped_by_user' | 'daily_limit'
```

- RunKind は `chat | agent | orchestrator` のまま（orchestrator ＝ 指揮役の 1 ターン）。

### 1.3 メッセージ（Message）— 変更

```ts
Message += {
  delivery: 'delivered' | 'queued',   // 既定 'delivered'。実行中に送られたユーザー発言は queued → 渡した時点で delivered
  meta: MessageMeta | null,           // 特別な描画用（本文は LLM 向け）
  usage: { costUsd: number; source: CostSource } | null, // assistant メッセージ単位の費用（推定可）
}
MessageMeta =
  | { kind: 'wake'; items: WakeItemView[] }       // 指揮役を起こした「状況の更新」
  | { kind: 'brief'; brief: SessionBrief }        // 子の最初のメッセージ（依頼）
  | { kind: 'schedule'; scheduleId; scheduledFor: Timestamp }
  | { kind: 'answer'; attentionId; choiceLabel: string | null }
WakeItemView = { sessionId; title: string; change: 'done'|'failed'|'review'|'needs_you'|'stopped'|'answer'|'budget'|'resume'; artifactIds: ArtifactId[] }
```

### 1.4 作業項目（Task）— 内部に残す

Task は UI から消すが、**子 1 人ぶんの依頼・依存・完了状態の記録**として残す（DAG と再試行の実装を活かす）。

- `session.spawn` が子 1 つにつき Task を 1 つ自動で作る（`assigneeSessionId` = 子）。人間・AI が Task を直接扱う必要はない。
- `projectId` を **nullable** に（プロジェクトなしの子）。依存（`dependsOn`）は「同じ根の木の中」に緩める。
- `TaskStatus` に `paused` を追加（止めた・再開できる。非終端）。
- 状態の意味を変える：`review` ＝ 人の確認が必要な成果物（コードの反映、または `reviewBy: human`）。それ以外は完了で `done`。
- 追加：`autoStart: boolean`（依存が済んだら daemon が起動する。既定 true）。

### 1.5 成果物（Artifact）— 一般化

```ts
ArtifactKind = 'document' | 'data' | 'link' | 'files'   // 新規（ユーザー向けの成果物）
             | 'diff' | 'commit' | 'test_result'         // 既存（diff ＝ UI の「コードの変更」）
             | 'file' | 'note'                           // 既存（読み込みのみ。表示は file→files, note→document）
Artifact base += {
  role: 'output' | 'evidence',     // 既定：diff/document/data/link/files → output、commit/test_result → evidence
  summary: string | null,          // 1 行
  review: { state: 'none'|'pending'|'accepted'|'rejected'; by: Actor|null; at: Timestamp|null; note: string|null },
  source: 'published' | 'final_message' | 'tracked_writes' | 'workspace_diff', // 既定 'published'
}
document: { format: 'markdown'|'text'; content: string /* ≤1MB */; path: string|null }
data:     { format: 'csv'|'json'; columns: string[]; rows: unknown[][] /* ≤5,000 行・2MB */; path: string|null }
link:     { url: string; label: string|null }
files:    { root: string /* workspace 相対の基準 */; files: { path; size; mimeType|null }[] } // 中身は artifact.read で読む
```

### 1.6 出番（Attention）— 新規

```ts
Attention = {
  id: AttentionId,                 // 'atn_'
  kind: 'question' | 'approval' | 'failure' | 'review' | 'budget' | 'stuck',
  status: 'open' | 'resolved' | 'dismissed',
  sessionId: SessionId, rootSessionId: SessionId,
  title: string,                   // ≤80 字、1 行、ID・JSON を含めない（例「価格（月額 980 円）を FAQ に載せる？」「pnpm add zod を実行」）
  detail: string | null,           // 展開したときだけ見せる補足
  choices: { id: string; label: string; tone: 'primary'|'neutral'|'danger' }[], // ≤4
  allowText: boolean,              // 自由入力（返信）を受けるか
  priority: number,                // 並び順（小さいほど上）。kind と経過時間から daemon が決める
  refs: { approvalId?; runId?; artifactId?; integrationId?; budgetId?; askedBySessionId? },
  resolution: { choiceId: string|null; text: string|null; by: Actor } | null,
  createdAt, resolvedAt: Timestamp|null,
}
```

kind ごとの既定の choices（daemon が付ける）：

| kind | 作られるとき | choices |
|---|---|---|
| question | `human.ask` | 質問者の選択肢（≤4）＋ allowText |
| approval | ツール使用の承認、テスト実行の承認（慎重）、権限 | `approve` 許可 / `reject` 拒否（「今後も許可」は detail のメニュー） |
| failure | 子・会話の実行が失敗（予算切れ・ループ以外） | `retry` 再試行 / `stop` 終える ＋ allowText（指示を送る） |
| review | コードの反映待ち、`reviewBy: human` の成果物 | `accept` 採用 / `redo` やり直し（allowText） |
| budget | 予算・日次上限に達した | `add_1` +$1 / `add_5` +$5 / `stop` |
| stuck | turn_limit / loop_detected / 起床の上限 | `continue` 続ける / `stop` 止める ＋ allowText |

- 元の状態が解消したら daemon が自動で `resolved` にする（承認が回答された、再試行が始まった、成果物が採用された、等）。
- 同じ原因の重複は作らない（`refs` で dedupe。LiteLLM キーの上限は全体で 1 件）。

### 1.7 受信箱（Inbox）— 新規・内部

```ts
InboxItem = {
  id: InboxItemId,                 // 'inb_'
  sessionId: SessionId,            // 起こされる会話
  kind: 'user_message' | 'child_update' | 'answer' | 'budget' | 'resume',
  refs: { messageId?; childSessionId?; attentionId?; runId? },
  status: 'pending' | 'consumed' | 'dropped',
  consumedByRunId: RunId | null,
  createdAt: Timestamp,
}
```

起床の唯一の入口。ポーリングしない（§3.2）。

### 1.8 権限（CapabilityGrant）— 変更

- `GrantLifetime = 'run' | 'session' | 'work'`。`work` ＝ その会話と子孫の作業がすべて落ち着く（実行中の Run・開いた出番・非終端の Task・未処理の受信箱が 0）まで。会話を subject にした旧 `run` は `work` として扱う（データは書き換えない）。daemon の停止・再起動の中断では失効しない。
- `GrantLimits += { maxChildren?: int; maxSchedules?: int }`。`maxChildren` がなければ `maxWorkers` を読む（互換）。
- 新しいスコープ：`CallScope.sessionIds`。agent は「自分の会話か、その子孫」の会話にしか触れない（判定は policy、§3.9）。

### 1.9 定期実行（Schedule）— 新規

```ts
Schedule = {
  id: ScheduleId,                  // 'sch_'
  sessionId: SessionId,            // 持ち主の会話（発火の子はこの下にぶら下がる）
  title: string,                   // 例「週次レポート」
  prompt: string,                  // 毎回の依頼文
  trigger: { kind: 'cron'; expr: string /* 5 フィールド */; tz: string /* IANA */ }
         | { kind: 'once'; at: Timestamp },
  run: { mode: 'chat'|'agent'; workspace: WorkspaceSpec; model: string|null;
         budgetUsd: number /* 1 回あたり、既定 1 */; supervise: boolean /* 人間が作ったときだけ true 可 */;
         includePrevious: boolean /* 前回の主な成果物を依頼に添える。既定 true */ },
  catchUp: 'latest' | 'skip',      // 既定 'latest'
  maxLatenessMin: int,             // 既定 720（12 時間）
  enabled: boolean,
  nextRunAt: Timestamp | null,
  lastRun: { scheduledFor; firedAt; sessionId: SessionId|null;
             outcome: 'started'|'skipped_overlap'|'missed'|'failed_to_start'; error: string|null } | null,
  expiresAt: Timestamp | null,
  createdBy: Actor, createdAt, updatedAt,
}
WorkspaceSpec = { kind: 'none' } | { kind: 'folder'; path: string } | { kind: 'worktree'; projectId: ProjectId; baseRef?: string }
```

### 1.10 費用の台帳（Usage ledger）— 新規・内部

```
usage_ledger(id INTEGER PK, ts, day /* settings.limits.timezone の YYYY-MM-DD */,
  session_id, root_session_id, project_id, run_id, model,
  component /* 'llm' | 'agent' | 'classifier' | 'adjust' */,
  cost_micro INTEGER /* adjust は負も可 */, input_tokens, output_tokens,
  source /* reported | estimated | unknown */)
INDEX (day), (root_session_id), (session_id)
```

### 1.11 プロジェクト・設定 — 変更

- `Project += { folderPath: string | null }`。`project.create` に必要なのは `name` だけ。`defaultBranch` / `testCommand` / `commitAuthor` は `repoPath` があるときだけ意味を持つ。
- `WorkspaceKind += 'scratch'`（`<ACC_HOME>/scratch/<sessionId>`、daemon 管理）。`directory` は既存の値を「ユーザーのフォルダ」として使う。`Workspace.projectId` を nullable に。
- `Settings +=`
  ```ts
  limits: { dailyUsd: number | null /* 既定 20 */; timezone: string /* 既定 OS のタイムゾーン */ },
  maxConcurrentAgents: int,      // 既定 10（旧 maxConcurrentRuns を読む）
  maxConcurrentChats: int,       // 既定 16（会話・指揮役の実行）
  autoResume: boolean,           // 旧 autoResumeOrchestrators を読む。子のエージェントの再開にも効く
  supervisor: { maxModelCallsPerRun: 24; maxWakesPerHour: 30; wakeDebounceMs: 1500; contextMessages: 40 },
  autoMode += { classifierCostUsd: 0.011 },
  ```
- `ID_PREFIXES += { inboxItem: 'inb', attention: 'atn', schedule: 'sch' }`。

### 1.12 移行（既存 DB をそのまま使えるように）

起動時、テーブルを作り直すマイグレーションの前に `acc.sqlite` を `acc.sqlite.bak-<version>` にコピーする（ダウングレードは非対応。新しい enum 値を古い daemon は読めない）。

| ID | 内容 |
|---|---|
| `core/0002_nullable_project` | `tasks` と `workspaces` を作り直し `project_id` を NULL 可に（CREATE new → INSERT SELECT → DROP → RENAME、インデックス再作成） |
| `core/0003_session_tree` | `sessions` に `root_session_id`・`state` 列とインデックス `(root_session_id)`、`(parent_session_id)` |
| `inbox/0001_init` | `inbox_items(id, session_id, kind, status, created_at, consumed_by_run_id, data)`、INDEX `(session_id, status)` |
| `attention/0001_init` | `attention(id, kind, status, session_id, root_session_id, priority, created_at, data)`、INDEX `(status, root_session_id)` |
| `schedules/0001_init` | `schedules(id, session_id, enabled, next_run_at, created_at, data)`、INDEX `(enabled, next_run_at)` |
| `cost/0001_ledger` | §1.10 |

起動時のバックフィル（冪等。各モジュールの `start`）：

1. sessions：`root_session_id IS NULL` の行を親をたどって埋める（JSON の `rootSessionId` も）。`state` は §3.7 の導出で一度だけ計算。
2. cost：既存の終端 Run ごとに 1 行（`run.usage`、`day` は `endedAt`、component は kind から）。`Session.cost` を再集計。
3. attention：`pending` の Approval、`failed` / `review` の Task（アーカイブされていない会話、直近 7 日）から出番を作る。
4. grants：会話を subject にした `lifetime: run` は `work` として評価（書き換えない）。
5. 旧 `note` / `file` 成果物は書き換えず、表示と API で document / files として扱う。

旧データの互換：zod スキーマに足すフィールドはすべて `.default()` か `.optional()`。enum は値を足すだけで消さない。

---

## 2. Protocol / Control API

### 2.1 ファイルの分け方（トラック間の衝突を減らす）

- 新しい型・メソッド・イベントは **トラックごとのファイル** `packages/protocol/src/ext/<track>.ts` に置き、各ファイルは `{ <track>Domain, <track>Methods, <track>Events }` を export する。`api.ts` と `events.ts` はそれらを spread するだけ（Core トラックが一度だけ書く）。
- 既存の `domain.ts` の変更（§1）は Core トラックだけが行う。

| ファイル | トラック |
|---|---|
| `ext/supervisor.ts` | T1 |
| `ext/spawn.ts` | T2 |
| `ext/outputs.ts` | T3 |
| `ext/attention.ts` | T4 |
| `ext/cost.ts` | T5 |
| `ext/schedule.ts` | T6 |
| `ext/home.ts` | T7 |

### 2.2 メソッド（新規・変更）

`tool` は LLM のツールに出せるか（Grant で絞られる）。「人間のみ」は agent が Grant を持っていても `forbidden`。

**会話の木（T1 / T2 / T7）**

```ts
'session.spawn': {            // T2。tool。permission 'session.spawn'
  params: { parentSessionId?: SessionId /* agent は省略で自分 */, title: string /*≤80*/,
            goal: string /*≤50k*/, doneWhen?: string[], mode?: 'chat'|'agent' /* 既定 agent */,
            workspace?: WorkspaceSpec /* 既定 §3.3 */, projectId?: ProjectId,
            after?: SessionId[] /* 同じ親の子。終わったら自動で始まる */,
            model?: string, runtime?: string, budgetUsd?: number,
            reviewBy?: 'none'|'human' /* 既定 none */, permissions?: PermissionPattern[], start?: boolean /* 既定 true */ },
  result: { session: Session; runId: RunId | null; budgetId: BudgetId | null; waitingFor: SessionId[] },
}
'session.send': {             // T1。変更：忙しくても拒否しない
  params: { sessionId, content, model?, interrupt?: boolean /* agent の実行中だけ意味を持つ */ },
  result: { messageId: MessageId; runId: RunId | null; delivery: 'started' | 'queued' | 'injected' },
}
'session.stop':   { params: { sessionId, tree?: boolean /* 既定 true */, reason?: string },
                    result: { stoppedSessionIds: SessionId[]; cancelledRunIds: RunId[] } },   // T1。tool
'session.resume': { params: { sessionId, tree?: boolean, message?: string },
                    result: { resumedSessionIds: SessionId[]; runIds: RunId[] } },            // T1。tool
'session.delegate': {         // T1。人間のみ。旧 session.grantOrchestration を置き換え（旧名は別名として残す）
  params: { sessionId, maxChildren?: int /* 既定 4 */, budgetUsd?: number /* 既定 3 */,
            projectId?: ProjectId | null /* 既定は会話のプロジェクト、なければ null */,
            allowSchedules?: boolean /* 既定 true */, lifetime?: 'session'|'work' /* 既定 session */, expiresAt? },
  result: { grant: CapabilityGrant; budget: BudgetAllocation | null },
}
'session.undelegate': { params: { sessionId }, result: { revoked: GrantId[] } },            // T1。人間のみ
'session.setBudget':  { params: { sessionId, limitUsd: number | null }, result: { budget: BudgetAllocation | null } }, // T5。人間のみ
'session.tree':   { params: { sessionId /* 木のどこでも */ },
                    result: { rootSessionId; nodes: SessionCard[] } },                        // T7。tool
'session.list':   // T7。params に追加 { parentSessionId?: SessionId | null; rootsOnly?: boolean }
'session.messages': // T7。result に追加 { streaming: { messageId; runId; text; reasoning } | null }
'session.create': // T2。params に追加 { workspace?: WorkspaceSpec }
```

**出番・質問（T4）**

```ts
'human.ask':          { params: { question: string /*≤200*/, choices?: string[] /*≤4, 各≤40*/, allowText?: boolean /*既定 true*/, detail?: string /*≤2000*/ },
                        result: { attentionId: AttentionId; status: 'asked' } },   // tool。非ブロッキング
'attention.list':     { params: { status?: AttentionStatus[]; rootSessionId?; sessionId?; limit; cursor? }, result: page(Attention) },
'attention.respond':  { params: { attentionId, choiceId?: string, text?: string }, result: Attention },
                      // 人間は全種類。agent は自分の子孫の question だけ（Supervisor が代わりに答える）
'attention.dismiss':  { params: { attentionId }, result: Attention },             // 人間のみ
```

**成果物（T3）**

```ts
'artifact.publish': { params: { kind: 'document'|'data'|'link'|'files', title, summary?,
                                content?: string, format?: string, path?: string, paths?: string[],
                                columns?: string[], rows?: unknown[][], url?: string },
                      result: Artifact },                // tool。子の既定の権限。path は自分の workspace 内だけ
'artifact.read':    { params: { artifactId, path?: string, offset?: int, limit?: int /* 既定 64KiB */ },
                      result: { content: string; mimeType: string | null; truncated: boolean } },
'artifact.review':  { params: { artifactId, decision: 'accept'|'redo', note?: string },
                      result: { artifact: Artifact; integrationId: IntegrationId | null } },
                      // コードの accept は人間のみ（反映を伴う）。redo は依頼者（親）も可
'artifact.list':    // params に追加 { role?: 'output'|'evidence'; rootSessionId?: SessionId }
```

**費用（T5）**

```ts
'cost.summary': { params: { range: 'today'|'7d'|'30d'|{ from: Timestamp; to: Timestamp },
                            groupBy: 'day'|'project'|'root'|'model', rootSessionId?: SessionId },
                  result: { totalUsd: number; estimated: boolean;
                            rows: { key: string; label: string; usd: number; estimated: boolean }[];
                            daily: { limitUsd: number | null; usedTodayUsd: number } } },   // tool（agent は自分の木だけ）
'budget.raise': { params: { budgetId, addUsd: number }, result: BudgetAllocation },          // 人間のみ。子なら親から切り出す
```

**定期実行（T6）**

```ts
'schedule.create':  { params: { sessionId, title?, prompt, trigger, run?: Partial<Schedule['run']>,
                                catchUp?, maxLatenessMin?, enabled?, expiresAt? }, result: Schedule },  // tool
'schedule.list':    { params: { sessionId?; rootSessionId?; enabled? }, result: { items: Schedule[] } },
'schedule.get':     { params: { scheduleId }, result: Schedule },
'schedule.update':  { params: { scheduleId, ...Partial<create params> }, result: Schedule },
'schedule.delete':  { params: { scheduleId }, result: { ok: true } },
'schedule.runNow':  { params: { scheduleId }, result: { sessionId: SessionId } },
'schedule.preview': { params: { trigger, count?: int /* ≤10 */ }, result: { times: Timestamp[] } },   // tool。式の確認用
```

**ホーム（T7）**

```ts
'home.get': {
  params: { doneWithinHours?: int /* 既定 12 */, maxNodesPerTree?: int /* 既定 40 */ },
  result: {
    now: Timestamp, lastSeq: int,                 // これ以降はイベントで差分
    totals: { working: int; needsYou: int; failed: int; spendTodayUsd: number; dailyLimitUsd: number | null; estimated: boolean },
    attention: Attention[],                       // open、priority 順（全体）
    trees: HomeTree[],                            // 根の会話ごと、出番 → 実行中 → 予定あり → 最近 の順
    upcoming: { scheduleId; sessionId; title; at: Timestamp }[],   // 次の 5 件
  },
}
HomeTree = {
  root: SessionCard, nodes: SessionCard[],        // 子孫（深さ優先、depth 付き、上限で打ち切り）
  hiddenNodes: int,                               // 打ち切った数
  counts: { working; queued; needsYou; failed; review; done; stopped },
  spend: { treeUsd: number; limitUsd: number | null; estimated: boolean },
  nextRunAt: Timestamp | null,                    // この木の会話に付いた定期実行の次回
  projectId: ProjectId | null,
}
SessionCard = {
  id, parentId: SessionId | null, depth: int, title: string,
  role: 'chat' | 'agent' | 'supervisor', state: SessionState, stateSince: Timestamp | null,
  now: string | null,                             // 実行中の名詞句
  costUsd: number, budget: { limitUsd: number; usedUsd: number } | null,
  outputs: { id: ArtifactId; kind: 'document'|'data'|'link'|'files'|'code'; title: string }[], // 最新 3
  attentionIds: AttentionId[],
  startedBy: 'human' | 'ai' | 'schedule',
  scheduleId: ScheduleId | null, lastActivityAt: Timestamp,
}
```

対象の根：出番がある／実行中・待ち／定期実行がある／ピン留め／`doneWithinHours` 以内に動いた、のいずれか。

**互換・廃止**

| メソッド | 扱い |
|---|---|
| `task.wait` / `integration.wait` | `tool: false`。指揮役のプロンプトとプリセットから外す。CLI 向けに残し、次の整理で削除 |
| `session.grantOrchestration` | `session.delegate` の別名（`maxWorkers` → `maxChildren`） |
| `task.spawnWorker` / `task.retry` | 残す（内部・CLI）。指揮役のプリセットからは外す（`session.spawn` / `session.send` / `artifact.review redo` で足りる） |
| `task.create` ほか `task.*` | 残す（内部）。プリセットからは外す |
| `project.inspectRepo` | 残す。新規 `project.inspectFolder`（T2）が git の有無も返す |

### 2.3 イベント（新規）

```ts
'session.state_changed': { sessionId, rootSessionId, parentSessionId, from: SessionState, to: SessionState, stateSince, now }
'session.now_changed':   { sessionId, rootSessionId, now: string | null }   // 1 秒に 1 回まで
'session.cost_updated':  { sessionId, rootSessionId, ownUsd, treeUsd, source }  // 1 秒に 1 回まで、木の祖先ぶんも
'message.updated':       { message: Message, changes: string[] }            // delivery の変化
'inbox.added' / 'inbox.consumed': { item } / { itemIds, runId }             // 監査用。Timeline の既定では隠す
'attention.opened' / 'attention.resolved': { attention }
'schedule.created' / 'schedule.updated': { schedule }, 'schedule.deleted': { scheduleId }
'schedule.fired':        { scheduleId, sessionId: SessionId | null, scheduledFor, outcome }
'budget.threshold':      { budgetId, rootSessionId, pct: 50 | 80 | 100 }
'cost.limit_reached':    { scope: 'daily', usedUsd, limitUsd }
```

変更：`budget.updated` は reserve / settle / cancelReservation では出さない（1 呼び出しごとの 2 行が Timeline を埋めていた）。allocate / release / raise と、1 秒に 1 回までの spent 更新だけ。

---

## 3. Daemon の振る舞い（モジュールごと）

### 3.1 新しいモジュールとサービス契約（`contracts.ts` に追加。Core が固定）

| サービス名 | 実装 | 主な関数 |
|---|---|---|
| `inbox` | `src/inbox/`（T1） | `deliver(sessionId, item)`：起動・差し込み・キューを決める唯一の入口。`drain(runId)`：区切りで渡す項目を取り出す |
| `spawner` | `src/sessions/spawn.ts`（T2） | `spawn(params, actor)`（`session.spawn` と定期実行が使う） |
| `outputs` | `src/integration/artifacts.ts` と `src/outputs/`（T3） | `finalize(run) → { needsReview: boolean; artifactIds }`：子の実行終了時に成果物を確定 |
| `attention` | `src/attention/`（T4） | `open(input)`、`resolveWhere(refs)`、`respond(...)` |
| `ledger` | `src/cost/`（T5） | `record(entry)`、`usedToday()`、`assertDailyLeft()` |
| `scheduler` | `src/schedules/`（T6） | `rearm()`、`fire(scheduleId, scheduledFor)` |
| `sessionState` | `src/home/`（T7） | `recompute(sessionId)`：§3.7 の導出。`Session.state/stateSince/now` の唯一の書き手 |
| `streams` | `src/home/streams.ts`（T7） | `append(runId, messageId, kind, text)`、`snapshot(sessionId)` |

`Session.cost` の唯一の書き手は `ledger`。`Session.state/now` の唯一の書き手は `sessionState`。ほかのモジュールはイベントを出すだけ。

### 3.2 受信箱と起床（T1）— 指揮役をイベント駆動にする

**届け方（`inbox.deliver`）**

| 宛先の会話 | 実行中でない | 実行中 |
|---|---|---|
| 指揮役（orchestrator） | すぐ新しい実行（trigger `user` または `wake`） | 次の区切りで差し込む（`delivery: injected`） |
| 普通の会話（chat） | すぐ実行 | 次の区切りで差し込む（ツールがなければ今の回答の後に新しい実行） |
| エージェント（agent） | すぐ実行 | キュー（今の実行の後）。`interrupt: true` なら今の実行を `cancelled`（`superseded`）にして、Runtime のセッションを再開する新しい実行に渡す |

- 「区切り」＝ `runToolLoop` の 1 ターンのツール結果をすべて返した後、次のモデル呼び出しの前。モデルが「ツールなしで答えた（終わろうとした）」直後にも 1 度確かめ、未処理があれば終わらずに続ける。
- ユーザー発言は送った時点でメッセージとして保存する（`delivery: queued`）。渡した時点で `delivered`（`message.updated`）。
- `RunsService.start` の「1 会話 1 実行」の不変条件は残す。`conflict` を受け止めてキューにするのは inbox の責任。実行の終了（`run.status_changed` 終端）を inbox が購読し、未処理があれば次の実行を始める。

**起床の材料（子の側から親へ）**

| kind | 作る条件 |
|---|---|
| `child_update` | 直接の子の状態が `done / failed / review / needs_you / stopped` に入った（親自身が止めた場合は作らない）。同じ子の未処理の項目は新しいもので置き換える |
| `answer` | その会話が出した質問に答えが付いた |
| `budget` | その会話の予算が 80% / 100% を越えた |
| `resume` | daemon の再起動でその会話の実行が中断された（中断した runId ごとに 1 回） |
| `user_message` | 人間・親からのメッセージ |

**起床の手順**

1. 会話に実行がなく、`supervision: active`、pending の項目がある → `wakeDebounceMs`（1.5 秒）待って項目をまとめる。
2. user_message 以外の項目を 1 通の system メッセージ（`meta.wake`、本文は LLM 向けに子の名前・状態・成果物の題名と ID）にして保存し、`orchestrator` の実行（trigger `wake`）を始める。項目は `consumedByRunId` を付けて consumed。
3. その実行は通常どおり答えて終わる。子が動いている間、指揮役の会話には実行がない（＝いつでも話しかけられる）。

**暴走の防止（daemon が強制）**

- 1 実行のモデル呼び出しは `supervisor.maxModelCallsPerRun`（24）まで。超えたら `failed`（`turn_limit`）→ 出番 `stuck`。
- 同じツール＋同じ引数が 3 回連続、または同じ assistant 本文が 3 回連続 → `failed`（`loop_detected`）→ 出番 `stuck`。
- 人間のメッセージなしの起床が 1 時間に `maxWakesPerHour`（30）を越えたら `supervision: paused`＋出番 `stuck`。
- 自分の実行中の操作の結果（spawn の成否など）は起床の材料にしない（ツール結果として返るため）。
- `paused` の会話は起こさない（項目は pending のまま貯める）。人間のメッセージか `session.resume` で `active` に戻る。

**指揮役の文脈**：毎回全履歴を送らない。system prompt ＋ 木のスナップショット（`session.tree` と同じもの）＋ 最初の依頼 ＋ 直近 `contextMessages`（40）件。

**一時的なエラー**：指揮役の実行が 429 / 5xx / タイムアウトで失敗したら、出番にせず 1 分 → 5 分 → 15 分後に `resume` 項目で起こし直す（3 回まで。超えたら出番 `failure`）。

### 3.3 子を起こす（T2）— `session.spawn`

1. 権限：permission `session.spawn`、`parentSessionId` は自分か子孫、`maxChildren`（終わっていない子の数）、委任の深さ（既定 1：子は子を起こせない）。判定から実行開始まで 1 トランザクション（既存の spawn と同じ）。
2. 作業場所の既定（`workspace` 省略時）：`mode: chat` → なし（作業場所を持たない）。`mode: agent` → プロジェクトに `repoPath` があり、依頼者が `worktree` を選んだときだけ worktree。それ以外は `none`（scratch）。**git は既定にしない**。
3. 会話を作る：`kind` = mode、`title` はそのまま（「Worker:」の接頭辞は付けない）、`parentSessionId`、`rootSessionId` = 親の根、`brief`。最初のメッセージは依頼文（`role: user`、`author` = 依頼者、`meta.brief`）。
4. Task を 1 つ作る（`projectId` は nullable、`assigneeSessionId` = 子、`dependsOn` = `after` の子の Task、`autoStart: true`）。
5. 予算：依頼者の実行に予算があれば、そこから `budgetUsd`（省略時は「空き − 依頼者の予約額 × 2」を残りの子の枠 + 1 で割る）を切り出す。依頼者に予算があるのに切り出せなければ拒否（予算の外で子を動かさない）。
6. 子の権限：子の会話を subject にした `work` の権限（`artifact.publish`・`human.ask`・自分の `session.get` / `artifact.list`、指定があればその部分集合）。深さ +1、`maxChildren: 0`。
7. `after` が終わっていなければ実行を始めず `queued`。依存の Task が `done` になったら daemon が自動で始める（`maxChildren` が埋まっていれば空いたときに）。
8. `orchestrator.decision` は「◯◯ を任せた」の 1 行だけ（ブランチ名・ランタイム名を書かない）。

**AI が始める実行**（`assertAgentMayStartRun` の変更）：agent は「自分の子孫で、その権限が自分の権限から委任されたもの」の会話に `session.send` / `session.resume` できる。それ以外は従来どおり拒否。

**ランタイム側の作業場所**：
- scratch：`<ACC_HOME>/scratch/<sessionId>`。会話のアーカイブから 30 日で削除。
- folder（`directory`）：ユーザーのフォルダ。書き込める実行は 1 つ（既存のロック）。git の操作・コミット・diff はしない。
- worktree：既存どおり。
- ToolGate に `writeRoot`（作業場所）と `readRoots`（プロジェクトの `folderPath` / `repoPath`、添付）を渡す。読み取り root の中は「作業場所の中の読み取り」と同じ扱い。書き込みは `writeRoot` の中だけ（絶対ルールは変えない）。
- プロンプトは中立の核＋作業場所ごとの断片（worktree のときだけ git・コミット・テストに触れる）。「専用の git worktree…自動でコミット」の固定文は worktree のときだけ。

### 3.4 子の終わり方（T2 が決め、T3 が成果物を確定）

子の実行が終端になったら（`workers.onRunEnded` を一般化）：

| 実行の結果 | 条件 | Task | 会話の状態 | 出番・起床 |
|---|---|---|---|---|
| completed | 開いた question がある | `blocked`（`waiting_for_human`） | needs_you | 親に child_update |
| completed | `outputs.finalize(run).needsReview` | `review` | review | 親が指揮役なら親に child_update（親がまとめて判断）。親がいなければ出番 `review` |
| completed | それ以外 | `done` | done | 親に child_update。予算を返す |
| failed（予算切れ） | — | `failed` | needs_you | 出番 `budget` |
| failed（turn_limit / loop） | — | `failed` | needs_you | 出番 `stuck` |
| failed（その他） | — | `failed` | failed | 出番 `failure`（子の会話に）、親に child_update |
| cancelled（止めた） | — | `paused` | stopped | 止めたのが親でなければ親に child_update |
| interrupted（再起動） | — | `ready`（`interrupted`） | queued | §3.10 で自動再開 |

`outputs.finalize(run)`（T3）：
1. この実行で `artifact.publish` された成果物があればそれを使う。
2. 作業場所が worktree：コミットして diff を `role: output`（コードの変更）として記録（既存）。変更があれば `needsReview: true`。
3. folder / scratch：実行中の書き込みツールのパス（Write / Edit / ゲートの判定で分かるもの）を集め、公開されていないものを `files`（`source: tracked_writes`）にまとめる。
4. 成果物が 1 つもなければ、最後の assistant 本文を `document`（`source: final_message`）にする。
5. `brief.reviewBy === 'human'` なら `needsReview: true`。

### 3.5 コードの工程（T3）— 任意

- 子 1 人のコードの変更を人が「採用」（`artifact.review accept`、人間のみ）→ その変更だけの統合を作り（既存 `integration.create`）、検証（`testCommand`）して **通れば反映**（採用の時点で人間が承認済み、`Integration.preApprovedBy` を記録）。通らなければ出番 `failure`（「テストが失敗」＋ やり直し）。
- 複数の子をまとめて反映するのは指揮役：`integration.create / run`（コードのプロジェクトのときだけプリセットとプロンプトに出す）。統合が `awaiting_approval` になったら出番 `review`（指揮役の会話、refs integrationId）。採用 = `integration.approve`。
- 反映できたら、含まれる Task を `done`、成果物の `review.state = accepted`、子の予算を返す（「統合しても done にならない」を直す）。
- `redo`（やり直し）＝ `task.retry` に指摘を付けて同じ子・同じ作業場所で再実行。
- 慎重プロファイルでの「テスト実行の承認」は既存のまま（出番 `approval`）。

### 3.6 出番（T4）

- `approval.requested` → 出番 `approval`。題は daemon が 1 行の名詞句で作る（`approvalTitleFor` を「pnpm add zod を実行」型に変える。「承認しますか」を付けない）。
- `human.ask`：出番 `question` を作って `{ attentionId, status: 'asked' }` を返す。実行は続けられる。子のエージェントには「答えがないと進めないなら、ここで作業を区切って終える」とプロンプトで伝える（終わっても §3.4 で needs_you に留まる）。
- 答え（`attention.respond`）→ 質問した会話にメッセージ（`role: user`、`meta.answer`、本文「回答: …」）を `inbox.deliver` → 実行がなければ新しい実行（エージェントは Runtime のセッションを再開）。question は会話に紐づくので、daemon の再起動をまたいでも消えない。
- 指揮役は自分の子孫の question に `attention.respond` で答えられる（人間と早い者勝ち）。ツールの承認には答えられない。
- `attention.respond` の振り分け：approval → `approval.respond`、failure.retry → `task.retry` / `run.retry`、*.stop → `session.stop`、review.accept → `artifact.review` / `integration.approve`、budget.add_N → `budget.raise`、stuck.continue → `session.resume`、text → `session.send`。
- 再起動：approval の出番は承認ごと取り消す（再開したエージェントがもう一度ツールを使えばゲートがまた判断する）。question はそのまま残す。
- モックのランタイムの `ask` 手順は Approval ではなく `human.ask` を呼ぶ（「承認しますかを承認しますか」の解消）。

### 3.7 状態と「いま何してる」（T7）

`sessionState.recompute(sessionId)` は次の入力だけから状態を決める（純関数＋読むだけ。単体テストで表を網羅）：

| 状態 | 条件（上から優先） |
|---|---|
| needs_you | 開いた出番（question / approval / budget / stuck）がこの会話にある |
| failed | 開いた出番 failure がある |
| working | 実行が running / awaiting_approval |
| supervising | 実行はないが、子孫に working / queued がある |
| queued | 実行が created / queued、または Task が pending / ready（依存待ち・枠待ち） |
| review | Task が review、または開いた出番 review |
| stopped | Task が paused、または `supervision: paused` |
| done | Task が done、または最後の実行が completed で子がいない agent |
| idle | それ以外（普通の会話の待機） |

- `run.status_changed` / `task.updated` / `attention.*` / `inbox.*` / 子の `session.state_changed` を購読し、該当する会話と祖先を再計算する。変わったら `session.state_changed`。
- `now`（≤24 文字の名詞句）：実行中だけ。`runtime/claude/normalize.ts` の `describeToolActivity` と同じ規則を daemon 側の 1 つの関数にまとめる。例：編集 →「faq.md を編集」、読み取り →「pricing.md を参照」、コマンド →「pnpm test を実行」、Web 検索 →「「競合 価格」を検索」、Web 取得 →「example.com を閲覧」、`session.spawn` →「2 人に依頼」、生成中 →「回答を作成中」、承認・質問待ち → 出番の題。Runtime の固定文（「Claude Code を起動しました」等）は「準備中」に丸める。
- ETA は出さない。`stateSince` を返し、UI が経過時間を出す。

### 3.8 費用と予算（T5）

1. **すべての使用を台帳へ**：`RunController.reportUsage` と `BudgetHold.settle` は `ledger.record` を通す（Core が呼び出し位置を作る）。`Session.cost.ownUsd` と、祖先すべての `treeUsd` を同じトランザクションで加算し、`session.cost_updated` を 1 秒に 1 回までまとめて出す。
2. **Claude の実行中の費用**：assistant メッセージの `message.usage`（input / output / cache の各トークン）を、同じ message id で重複を除いて取り、単価表で推定して `estimate` として報告。`result` が来たら `total_cost_usd` の差分（既存の基準値ロジック）を確定値とし、推定との差を `adjust` 行で補正（負もあり。`BudgetService.adjustSpend` を追加）。
3. **単価**：LiteLLM の `/model/info`（取れれば、キャッシュ 1 時間）→ 組み込み表（Claude 系）→ 不明なモデルは既知の最高単価で推定（`unknown` で 0 にしない）。
4. **上限を実行中に効かせる**：Claude の query に `maxBudgetUsd` = min（予算の空き、日次の残り）を渡し、`error_max_budget_usd` を `budget_exhausted` にする。推定の積算で空きが 0 を切ったら daemon も `interrupt()` する。
5. **子の終了で返す**：子の Task が done / failed / cancelled / review になり実行がなければ、子の予算を `releaseTree`。やり直し・再開のときは親からもう一度切り出す。
6. **超過の伝播**：子の spent が limit を越えたら、越えた分を親の `allocatedUsd` に足す（根まで）。根の空きが 0 以下なら木の実行はすべて止まる。
7. **日次上限**：LLM 呼び出しの予約前と `reportUsage` ごとに `ledger.assertDailyLeft()`。超えたら新しい呼び出しを拒否し、実行中のエージェントを止める（`daily_limit`）。出番 `budget`（全体で 1 件、choices「今日だけ +$10」「設定」）と `cost.limit_reached`。指揮役は上限が上がるまで起こさない。
8. **分類器の費用**：`Run.permission.judge === 'client'` の間、フックが分類器に任せた（何も返さなかった）ツール使用 1 回ごとに `classifierCostUsd` を `classifier` 行で記録（推定）。サーバー判定のときは 0。
9. **LiteLLM のエラー**：キーの予算超過（`budget_exceeded` 系）を `llm_quota_exceeded` に分類（出番 budget、全体で 1 件）。429 / 5xx / 接続断は、トークンを 1 つも受け取っていなければ Gateway が Retry-After を尊重して最大 2 回再試行（最大 20 秒）。
10. **見える所**：`Session.cost`（全会話）、`SessionCard.budget`（予算のある会話）、`HomeTree.spend`（木）、`home.get.totals`（今日 / 日次上限）。`budget.threshold` は 50 / 80 / 100%。

### 3.9 権限（Core と T1 / T2）

- 指揮役のプリセット `SUPERVISOR_PERMISSIONS`（`orchestrator/grant.ts`、T1）：`session.spawn`、`session.send`、`session.stop`、`session.resume`、`session.tree`、`session.get`、`session.messages`、`session.update`（自分と子孫の title だけ）、`artifact.list/get/read`、`artifact.review`（redo だけ。accept のコードは人間）、`attention.list`、`attention.respond`（question だけ）、`human.ask`、`schedule.*`（`allowSchedules` のとき）、`cost.summary`、`orchestrator.recordDecision`、`project.get`。コードのプロジェクトのときだけ `integration.create/run/get/list/resolveWithAgent`、`workspace.diff`。
- スコープ `sessionIds`（Core）：agent の Grant の subject の会話を根とする部分木の中だけ。部分木の判定は `rootSessionId` と親をたどる（深さは小さい）。
- 有効期間 `work` の失効（Core）：`sessionState` が「木が落ち着いた」（§1.8）と判定したとき。

### 3.10 再起動と復旧

起動時の順序（既存の `core/recovery.ts` の後）：

1. 実行中だった Run は既存どおり `interrupted`。ロックと予約を解放。
2. approval の出番を取り消す。question の出番は残す。
3. 中断された各会話に `resume` 項目（runId ごとに 1 回）。
4. `settings.autoResume` かつ権限・予算が有効なら：
   - 指揮役：通常の起床（§3.2）。
   - 子のエージェント：同じ会話・同じ作業場所で新しい実行（trigger `resume`、Runtime のセッションを再開、本文「再起動で中断されたので続きから」）。**同じ中断から自動再開するのは 1 回だけ**（再起動のループで費用を使い続けない）。
   - 普通の会話：自動では再開しない（途中の回答は残す）。
5. 定期実行：§3.11 の取りこぼしの規則で次回を計算。
6. 予算：既存どおり未確定の予約を取り消す。推定のまま終わった費用は `estimated` で残す。

### 3.11 定期実行（T6）

- **時計**：最も近い `nextRunAt` に setTimeout を 1 本だけ張る（unref）。スケジュールの変更と発火のたびに張り直す。スリープ明けにタイマーが遅れて発火したら、その時点で取りこぼしの規則を当てる。ポーリングはしない。
- **cron**：5 フィールド＋タイムゾーン。実装は小さな依存ライブラリ（`croner` を第一候補、§7 Q5）か自前のパーサ。プリセット（毎時・毎日 HH:MM・平日 HH:MM・毎週 曜日 HH:MM・1 回だけ）は UI が cron に変換する。
- **発火**：`spawner.spawn` で持ち主の会話の子を作る。`title` = `<schedule.title> · 11/5 9:00`、`scheduleId`、最初のメッセージ `meta.schedule`、`brief.goal` = prompt（`includePrevious` なら前回の主な成果物の題と冒頭 4,000 字を添える）。`startedBy: 'schedule'`（actor `system:scheduler`）。
- **予算**：AI が作った定期実行は、発火のたびに作った AI の会話の予算から `budgetUsd` を切り出す（切り出せなければ `failed_to_start`＋出番 budget）。人間が作ったものは発火ごとに根の予算 `budgetUsd`（日次上限の中）。
- **取りこぼし**：`catchUp: latest` → 逃した回が 1 つ以上あれば、最新の 1 回だけ、予定時刻から `maxLatenessMin` 以内なら起動時（またはスリープ明け）に実行。越えていれば `missed` を記録して次へ。`skip` → 5 分以上遅れたら実行しない。過去分を複数回走らせることはない。
- **重なり**：前回の発火の子がまだ終わっていなければ今回は `skipped_overlap`。
- **AI による作成**：permission `schedule.create`、持ち主の会話は自分か子孫、`limits.maxSchedules`（既定 5）、`run.supervise` は不可（AI が作った定期実行の子は子を起こせない）、`createdBy` に AI と記録（UI は AI のバッジ）。人間は一覧で止める・消すことができる。
- **木とホームでの見え方**：発火の子は持ち主の下にぶら下がり、ホームでは最新の 1 つだけ表示（古いものは `hiddenNodes`）。持ち主のカードと `HomeTree.nextRunAt` に次回。`home.get.upcoming` に次の 5 件。

### 3.12 Runtime（T2 / T5 / T3 / T4）

- 契約（`contracts.ts`）：`AgentRunInput += { writeRoot: string; readRoots: string[]; maxBudgetUsd: number | null }`。`AgentEvent.usage += { phase: 'estimate' | 'final' }`。
- Claude（T5）：§3.8 の 2・4。`maxTurns` は渡さない（エージェントの作業を途中で切らない。止めるのは予算と人間）。
- mock（Core がステップ表に分割 → 各トラックが `runtime/mock/steps/<name>.ts` を追加）：`publish`（T3）、`ask` → `human.ask`（T4）、ステップごとの推定費用（T5）。
- 実行の枠（T1）：`agent` は `maxConcurrentAgents`、`chat` / `orchestrator` は `maxConcurrentChats`。`lendSlot` は使わなくなる（wait 系をツールから外すため）。

### 3.13 モックの指揮役（T1）— 書き直し

`mock/orchestrator` を「最後のメッセージの種類」だけで決める状態機械にする：

| 最後に来たもの | 返す |
|---|---|
| 目標（ユーザー発言） | `session.spawn` × 3（文書・データ・リンク調査の非コード。プロジェクトに repo があれば 1 つはコード）＋ `recordDecision`（同じ返事の中） |
| spawn の結果 | 本文だけ「3 人に任せました」（ツールなし → 実行が終わる） |
| 起床（一部完了） | 本文だけ「1/3 完了…」 |
| 起床（question） | 答えられるものは `attention.respond`、それ以外は本文だけ |
| 起床（全員完了） | 最終報告の本文だけ（成果物の題を並べる。ツールなし） |
| 「いま何してる」 | `session.tree` → 本文 |
| 「止めて」 | `session.stop` → 本文 |

**不変条件**：ツール呼び出しが `recordDecision` だけの返事を作らない。最終報告にはツールを付けない。デモ（`system.setupDemo`）は git なしの「新製品ローンチ準備」（調査・FAQ・告知文・質問 1 件・週次レポートの定期実行 1 本）に替える。

---

## 4. 消すもの・隠すもの

| 対象 | 扱い |
|---|---|
| 指揮役の長い待機（`task.wait` / `integration.wait` をツールで使うこと、`lendSlot`） | ツールとプロンプトから削除。メソッドは CLI 用に残す |
| 会話への送信の `conflict`（「このセッションでは別の Run が実行中です」） | 削除（キュー／差し込み） |
| 「Worker:」の接頭辞、`spawnRationale` のブランチ名・ランタイム名 | 削除 |
| 指揮役の system prompt の「You lead coding agents」「git worktree」「test command」 | 中立の核へ。コードの断片は repo があるときだけ |
| `buildAgentPrompt` の worktree 固定文 | 作業場所ごと |
| `budget.updated` の reserve / settle ごとの発行 | 削除（§2.3） |
| 再開の文章通知 `ORCHESTRATOR_RESUME_NOTICE` | `meta.wake`（resume）に置き換え |
| デモの Node リポジトリ・`node --test` | 非コードのデモへ |
| 権限ダイアログの 3 択・説明文、`lifetime: run` の既定 | `session.delegate` の既定値（4 人・$3・この会話）で 1 クリック |
| UI に出る語：Run / Task / Worker / Orchestrator / Integrator / worktree / ブランチ / Grant / Core Daemon / reserved / settled / ID / JSON | UI では使わない（§6.2） |

---

## 5. 実装トラック

### 5.1 進め方

1. **T0 Core** を先に入れる（契約・スキーマ・マイグレーション・呼び出し位置・スタブ）。これがマージされるまで他は始めない。
2. T1〜T7 を並列（各 worktree）。各トラックは自分のファイルだけを触る。共有ファイルは下の表のとおり。
3. マージ順：T2 → T4 → T3 → T1 → T5 → T6 → T7（共有ファイルの衝突が少ない順。どのトラックも main を壊さないこと）。
4. 各トラックは `pnpm check`（lint・typecheck・test）を通し、architecture.md の自分の節を同じコミットで直す（Core が節の見出しを先に作る）。
5. desktop（`apps/desktop`）は UI フェーズまで作り直さない。protocol の変更で型が壊れる箇所は、**Core が最小の修正で通す**。各トラックは protocol を足すだけ（壊さない）。

### 5.2 T0 Core（先行）

- **持つファイル**：`packages/protocol/src/{domain,common,api,events,index}.ts`、`packages/protocol/src/ext/*.ts`（全トラック分のスキーマを書く）、`packages/daemon/src/contracts.ts`、`core/migrations.ts`、`core/repos.ts`、`modules.ts`、新しいモジュールのスタブ（`inbox/`、`attention/`、`cost/`、`schedules/`、`home/`：サービスを no-op、メソッドは `not_implemented`）、`policy/grants.ts`（lifetime `work`、CallScope `sessionIds`、再起動で失効させない）、`api/policy.ts`、`packages/cli`（`session.send` の結果の変更）、desktop の型の最小修正。
- **継ぎ目の作り直し**（後の衝突を減らすため）：
  - `sessions/index.ts` のメソッドを `sessions/methods/<method>.ts` に分ける。
  - `runs/manager.ts` の使用量の処理を `runs/usage.ts`（`UsageAccountant`）に出し、`ledger.record` を呼ぶ位置を作る。`emitDelta` から `streams.append` を呼ぶ。
  - `runtime/mock/runtime.ts` を手順の表（`STEP_HANDLERS`）にし、手順を `runtime/mock/steps/*.ts` に分ける。
  - architecture.md に §2.13〜§2.19（各トラックの節）の見出しを作る。
- **受け入れテスト**：
  - 古い DB（このブランチの `acc.sqlite` を作るテスト用フィクスチャ）→ 起動 → すべての行が新しいスキーマで読める。tasks / workspaces の行数と `project_id` が保たれる。バックアップファイルができる。
  - `rootSessionId` のバックフィル（3 階層）。台帳のバックフィル（終端 Run の費用の合計が一致）。
  - 新しい ext の zod スキーマの往復（params / result / events）。
  - スコープ `sessionIds`：子孫は可、兄弟の木は `forbidden`。
  - lifetime `work`：再起動で失効しない、木が落ち着くと失効する（`sessionState` のスタブを差し替えて検証）。
  - `pnpm check` が緑（既存のテスト 661 件を含む）。

### 5.3 T1 Supervisor（受信箱・起床・止める・暴走防止）

- **持つファイル**：`inbox/*`、`orchestrator/{executor,mockModel,resume,index,grant}.ts`、`sessions/methods/{send,stop,resume,delegate}.ts`、`runs/manager.ts`（枠の 2 系統、`superseded`）、`llm/toolLoop.ts`（区切りでの差し込み、上限、ループ検出）、`ext/supervisor.ts`、`orchestrator/demo.ts`。
- **依存する契約**：`inbox`・`spawner`・`attention.open`・`sessionState`（スタブで可）、`session.spawn` の params（T2 実装前は mock でテスト）。
- **受け入れテスト**（daemon の結合テスト、mock モデル）：
  1. 目標 → 指揮役が子を 3 つ起こし、**その実行は completed で終わる**。子が動いている間、指揮役の会話に実行がない。
  2. 子が動いている間の「いま何してる？」→ `delivery: started`、`session.tree` を使って答える。`conflict` は一度も起きない。
  3. 指揮役の実行中の送信 → `injected`、同じ実行の次のモデル呼び出しに含まれる。
  4. 子 2 人が 1.5 秒以内に終わる → 起床は 1 回で、`meta.wake` に 2 人。
  5. `session.stop`（木）→ 子の実行がすべて cancelled、Task は paused、その後は起床しない。`session.resume` で再開。
  6. 実行中のエージェントへの送信 → `queued` → 今の実行の後に渡る。`interrupt: true` → 今の実行が `superseded`、新しい実行が始まる。
  7. 子の作業中に daemon を再起動 → 指揮役（既定の権限のまま）が起き、子は 1 回だけ自動で再開。
  8. 同じツール呼び出しを繰り返す台本 → `loop_detected`、出番 stuck、以後起床しない。`maxModelCallsPerRun` 超過 → `turn_limit`。
  9. 起床の上限（偽の時計）→ `supervision: paused`＋出番。
  10. モックのデモが最終報告で止まる：最終報告は 1 回、指揮役の実行数 ≤ 子の数 + 2、同じ assistant 本文が 2 回続かない。
  11. 枠：エージェント 10 本が動いていても、指揮役と会話の実行がすぐ始まる。

### 5.4 T2 子を起こす・作業場所・完了（汎用化）

- **持つファイル**：`sessions/spawn.ts`、`sessions/methods/{spawn,create}.ts`、`orchestrator/workers.ts`（`onRunEnded` の一般化、Worker 名の廃止）、`tasks/*`、`workspace/*`（scratch・folder）、`projects/*`（`folderPath`、`inspectFolder`）、`runtime/{executor,gate,policy}.ts`（writeRoot / readRoots、中立のプロンプト）、`policy/grants.ts` の spawn 判定（`assertCanSpawnChild`、`assertAgentMayStartRun`）、`ext/spawn.ts`。
- **依存する契約**：`outputs.finalize`（T3。スタブは「最後の本文を document に」）、`attention.open`（T4 スタブ）、`ledger`（スタブ）。
- **受け入れテスト**：
  1. `session.spawn` の 4 通り：chat 子、agent＋none（scratch）、agent＋folder、agent＋worktree。git のないプロジェクトを名前だけで作れる。
  2. scratch のエージェントがプロジェクトのフォルダを読めて、外には書けない（絶対ルールの既存テストも緑）。
  3. `after`：依存の子が done になったら自動で始まる。`maxChildren` を越える spawn は待ち、空いたら始まる。深さ 2 は `limit_exceeded`。
  4. AI が chat 子を起こせる（権限と予算の中）。親に予算があって切り出せなければ拒否。
  5. 完了の表（§3.4）を全行テスト：非コード → done＋document 成果物、コードの変更 → review、開いた質問 → blocked / needs_you、失敗 → 出番 failure。
  6. 子の会話の最初のメッセージが依頼（`meta.brief`）で、題に「Worker:」が付かない。
  7. worktree 以外の作業場所のプロンプトに git / worktree / テストの語が出ない（文字列のテスト）。
  8. 既存の `e2e:slice`（コードの縦の流れ）が `session.spawn` 経由でも通る。

### 5.5 T3 成果物とコードの工程

- **持つファイル**：`integration/*`（`artifacts.ts` を含む）、新規 `outputs/`（finalize、書き込みの追跡、`artifact.publish/read/review`）、`runtime/mock/steps/publish.ts`、`ext/outputs.ts`。
- **依存する契約**：`attention.open`、Task の状態の setter（T2 が `tasks` に持つ既存のもの）。
- **受け入れテスト**：
  1. `artifact.publish` の 4 種類（サイズの上限、workspace の外のパスは拒否）。`artifact.read` の上限と切り詰め。
  2. finalize：公開済み > worktree の diff > 書き込みの追跡 > 最後の本文、の順。
  3. コードの採用：`artifact.review accept` → 統合 → テスト成功 → 反映 → Task done・予算返却。テスト失敗 → 出番 failure。agent の accept は `forbidden`。
  4. 指揮役の複数の子の統合（既存 e2e:slice / e2e:conflict の daemon 側）が通り、反映で Task が done になる。
  5. 旧 note / file の成果物が document / files として読める。

### 5.6 T4 出番と質問

- **持つファイル**：`attention/*`、`runs/` の Approval → 出番の購読（`attention/` 側で `approval.*` を購読する。manager は触らない）、`runtime/tools.ts`（`approvalTitleFor` の文言）、`runtime/mock/steps/ask.ts`、`ext/attention.ts`、`core/recovery.ts`（question を残す）。
- **依存する契約**：`inbox.deliver`（T1 スタブ：直接 `session.send` 相当で可）。
- **受け入れテスト**：
  1. mock エージェントの `human.ask`（選択肢 2 つ）→ 出番 question（題 1 行、危険度・「今後も許可」なし）→ 実行は終わる → 会話は needs_you。
  2. 答え → 会話に回答のメッセージ → 新しい実行で続きを作業。
  3. 質問を出したまま daemon を再起動 → 出番は残り、答えると届く。
  4. 指揮役は自分の子孫の question に答えられる。別の木の質問や approval には `forbidden`。
  5. 出番の自動解消：承認の回答、再試行の開始、採用、予算の追加。
  6. `attention.respond` の振り分け（§3.6）を種類ごとにテスト。
  7. 承認の題が「〜を承認しますか」を含まない。

### 5.7 T5 費用と予算

- **持つファイル**：`cost/*`（台帳、集計、`cost.summary`）、`runs/usage.ts`、`policy/budget.ts`（返却・伝播・adjustSpend・raise・閾値イベント）、`runtime/claude/{normalize,runtime}.ts`（メッセージごとの使用量、maxBudgetUsd）、`llm/{openai,gatewayErrors}.ts`、新規 `llm/pricing.ts`、`runtime/mock/steps/usage.ts`、`sessions/methods/setBudget.ts`、`ext/cost.ts`。
- **依存する契約**：子の終了（T2 の Task の状態の変化を購読）、`attention.open`。
- **受け入れテスト**：
  1. mock エージェントの手順ごとの推定で、**実行中に**予算の spent と `Session.cost` が増える。途中で予算が尽きると止まる。
  2. Claude の normalize：同じ message id の usage を二重に数えない。result で確定値に補正（記録済みの SDK 出力のフィクスチャで契約テスト）。`error_max_budget_usd` → budget_exhausted。
  3. 子が done → 未使用分が親に戻る（スクショ 31 の「空き $0.20 で詰む」の再現が通る）。子の超過が根まで伝播する。
  4. 日次上限：上限を越えると新しい LLM 呼び出しが拒否され、出番 budget が 1 件だけ。`cost.summary` の 4 つの groupBy。
  5. `judge: client` のときだけ分類器の推定費用が台帳に載る。
  6. 価格不明のモデルが 0 にならない。`budget.raise` は人間だけ。
  7. LiteLLM のキーの予算超過が分類される。429 の再試行（トークン受信前だけ）。

### 5.8 T6 定期実行

- **持つファイル**：`schedules/*`、`ext/schedule.ts`、（必要なら）依存の追加 `packages/daemon/package.json`。
- **依存する契約**：`spawner.spawn`（T2。テストはスタブ）、`core/clock.ts` の偽の時計、`budget`。
- **受け入れテスト**（偽の時計）：
  1. cron と once、`schedule.preview` の次の 5 回（タイムゾーン、DST をまたぐ 1 件）。
  2. 発火で持ち主の下に子ができる（題・`scheduleId`・`meta.schedule`・前回の成果物の添付）。
  3. 取りこぼし：12 時間以内なら最新の 1 回だけ、越えたら missed。過去分を複数回走らせない。`skip` の挙動。
  4. 重なり → `skipped_overlap`。無効化・期限切れ・削除で止まる。再起動で次回を計算し直す。
  5. AI の作成：権限・持ち主の範囲・`maxSchedules`・予算の切り出し・`supervise` 不可。
  6. `schedule.runNow`。

### 5.9 T7 ホームと状態

- **持つファイル**：`home/*`（`state.ts` 導出、`now.ts` 名詞句、`home.ts` 集約、`streams.ts`）、`sessions/methods/{tree,list,messages}.ts`、`ext/home.ts`。
- **依存する契約**：各エンティティのフィールド（Core）。T1〜T6 はイベントを出すだけ。
- **受け入れテスト**：
  1. 状態の導出表（§3.7）を全行。`now` の名詞句の表（ツールごと、24 文字で切る、Runtime の固定文の丸め）。
  2. 13 会話のフィクスチャで `home.get` 1 回に、各木の子の状態・now・費用・出番・次回の予定がそろう。SQL の回数が木の数に比例しない（N+1 なし）。50ms 以内。
  3. イベントだけで差分を追える：`session.state_changed` / `now_changed` / `cost_updated` を当てた結果が、もう一度 `home.get` した結果と一致する。
  4. ストリーミングの途中で `session.messages` → `streaming` に書きかけの本文（gap-audit のバグ 1）。
  5. `session.list` の `rootsOnly` / `parentSessionId`、`session.tree`。

### 5.10 共有ファイルの一覧

| ファイル | 触るトラック | 衝突の避け方 |
|---|---|---|
| `protocol/src/api.ts`・`events.ts`・`domain.ts` | T0 のみ | 各トラックは `ext/<track>.ts` だけ |
| `daemon/src/contracts.ts` | T0 のみ | 変更が要るときは T0 の担当者に依頼（全員に影響） |
| `policy/grants.ts` | T0 → T2 | T0 が lifetime / scope、T2 が spawn の判定（関数を分ける） |
| `runs/manager.ts` | T1 | T5 は `runs/usage.ts`、T7 は `streams` サービス |
| `runtime/mock/*` | T3 / T4 / T5 | `steps/<name>.ts` を足すだけ |
| `orchestrator/workers.ts` | T2 | T3 は `outputs.finalize` の中で完結 |
| `core/recovery.ts` | T4 | T1 の再開は `orchestrator/resume.ts` 側 |
| `docs/persistent/architecture.md` | 全員 | 自分の節だけ（T0 が見出しを作る） |

---

## 6. UI フェーズへの申し送り

### 6.1 画面ごとに API から必要なもの

| 画面 | 使う API | 中身 |
|---|---|---|
| ホーム（旧 司令室） | `home.get` ＋ イベント（`session.state_changed` / `now_changed` / `cost_updated` / `attention.*` / `schedule.*`） | 根の会話ごとに 1 レーン：子のチップ（状態の色・アイコン・now）、木の費用メーター、出番のアイコン数、次回の予定。出番はチップの中で強調し、選ぶと 1 行の操作帯（title＋choices）。上段に今日の費用 / 日次上限、出番の数 |
| サイドバー | `session.list({ rootsOnly })`、`session.tree` | 会話の木（字下げ・ツリー線、子は既定で折りたたみ）、プロジェクトでまとめる、時計アイコンで次回 |
| 会話（旧 Focus） | `session.messages`（`streaming` 付き）、`session.send`（`delivery`）、`session.tree` | 子の最初に依頼カード（`meta.brief`）。指揮役の会話の起床は状況カード（`meta.wake`）。spawn はアバター列（子の状態色、クリックで移動）。送信待ちのメッセージに印。実行中の入力欄は「次の区切りで渡す」（エージェントは「割り込む」の切り替え） |
| 成果物ビュー | `artifact.list({ role: 'output' })`、`artifact.read`、`artifact.review` | document は Markdown を描画、data は表、files は一覧、code は diff と「採用」。完了条件（`brief.doneWhen`）を並べる |
| 出番の処理 | `attention.list`、`attention.respond` | 1 行＋ボタン。キーボードで順に処理（Y / N / 数字キーで選択肢） |
| 定期実行 | `schedule.*`、`schedule.preview` | 会話のメニュー「繰り返す」→ プリセット → 次回の表示 |
| 費用 | `cost.summary` | 日・プロジェクト・木・モデルの積み上げ |
| 任せる | `session.delegate` | 「任せる」ボタン 1 つ（既定値）。調整は後からチップで |
| Timeline | `events.list` | 既定は人の出来事（依頼・質問・失敗・完了・採用）だけ。予算・受信箱・ツール結果は詳細表示のときだけ |

### 6.2 語彙の対応（UI の文言）

| 内部 | UI |
|---|---|
| Session（根） | 会話 |
| Session（agent の子） / Worker | エージェント（役割は語でなくアイコン） |
| Orchestrator / supervisor | 語を出さない（◆ アイコン。「任せる」でなる） |
| Artifact（role output） | 成果物（document → 文書、data → 表、files → ファイル、diff → 変更、link → リンク） |
| Attention | 出番（question → 質問、approval → 確認、failure → 失敗、review → 確認待ち、budget → 予算、stuck → 止まっている） |
| Task / Run / Grant / Budget ノード | 出さない（予算は「予算」の金額だけ） |
| Workspace（scratch / directory / worktree） | 作業場所：なし／フォルダ／コード |
| Integration / apply | コードのときだけ「反映」 |
| paused / stopped | 停止中（再開できる） |
| Schedule | 繰り返し（次回の時刻） |

### 6.3 UI から消えるもの

ブランチ名の列・+N −M の列（コードの確認待ちのときだけ）、要対応の段落カード、「Orchestrator 権限: なし」、チャットの「変更 / テスト / ログ」タブ（中身があるときだけ）、Run 履歴と attempt 番号、トークン数（詳細の中だけ）、権限ダイアログの 3 択と説明文、空状態の 3 択、Ctrl+N で即座に会話を作ること（最初の送信で作る）、設定のテストコマンド（コードのプロジェクトだけ）、pid・ポート・メソッド数（診断の中だけ）、ID・JSON・reserved / settled。

### 6.4 5 秒テストとの対応

開かずに分かるべき 3 つは、すべて `home.get` 1 回のデータで描ける：**全体の進捗**（各木の `counts`＋チップの状態色）、**問題**（`failed` / `stuck` の状態と出番）、**人間の出番**（`attention` を priority 順）。各チップの `now` が「何をしているか」、`stateSince` が「どれくらい経ったか」、`spend` が「いくら使ったか」に答える。

---

## 7. リスクと未決事項

### 7.1 リスク

| # | リスク | 対策・判断 |
|---|---|---|
| R1 | Claude の実行中の費用は推定値。単価表が古いと外れる | 確定値で補正。推定は UI で「≈」。単価は LiteLLM の `/model/info` を優先 |
| R2 | SDK の assistant メッセージがコンテンツブロックごとに同じ usage を繰り返す | message id で重複を除く（契約テストで固定） |
| R3 | 区切りで差し込んだ発言が、ツール結果の並びを崩してモデルを混乱させる | 差し込みはそのターンのツール結果をすべて返した後だけ。本文に「（作業中に届いた発言）」の前置き |
| R4 | 指揮役の起床ごとに文脈を送るので、木が大きいと費用が増える | 文脈を木のスナップショット＋直近 40 件に限る（§3.2）。起床はまとめる（1.5 秒） |
| R5 | 非ブロッキングの `human.ask` の後、エージェントが答えを待たずに進めてしまう | プロンプトで区切らせる。進めてしまっても出番は残り、答えは次の実行に届く（壊れはしない） |
| R6 | folder の作業場所は書き込みが 1 本ずつになり、並列にならない | 仕様として受け入れる（並列に書くならコードの worktree か scratch） |
| R7 | マシンの停止中は定期実行が動かない | 取りこぼしの規則で起動時に 1 回。常時動かすのはリモート実行（範囲外） |
| R8 | 新しい enum 値で古い daemon に戻せない | 起動時のバックアップ。ダウングレード非対応を明記 |
| R9 | `Session` の JSON を複数のサービスが更新する（state / now と cost） | 単一プロセス・同期トランザクションの read-modify-write なので競合しない。イベントは専用のものに分ける |
| R10 | 既定の日次上限 $20 が業務の途中で全体を止める | 出番 budget の「今日だけ +$10」で 1 クリック。設定で変更・無効化 |

### 7.2 未決（実装前に確かめる）

| # | 問い | 既定の扱い |
|---|---|---|
| Q1 | SDK の `maxBudgetUsd` は再開したセッションの累計に対して効くのか、query ごとか | 実機で確認（T5 の最初の作業）。query ごとなら「その実行で使ってよい額」を渡す |
| Q2 | Claude の実行中（streaming input）にユーザー発言を渡せるか | v1 はキュー＋明示の割り込み。渡せるなら後でエージェントも「区切りで差し込む」に揃える |
| Q3 | 子が子を起こす（深さ 2）を許すか | v1 は不可（concept §11 の初期値）。定期実行の `supervise` は人間が作ったときだけ |
| Q4 | 常設の「オペレーター」会話（パレットの「AI に頼む」の行き先）を作るか | 今回は作らない。どの会話も「任せる」で同じ力を持てる |
| Q5 | cron の依存（`croner`）を足してよいか | 依存の方針がなければ足す。だめなら自前の 5 フィールドパーサ（T6 の範囲） |
| Q6 | コネクタ（GitLab・ブラウザ）がないと「毎朝の確認」の価値が限られる | 範囲外。定期実行の `run` に将来 `connectors` を足せる形にしておく |
| Q7 | 非コードの成果物も人が「採用」したいか | 既定は採用不要（`reviewBy: none`）。依頼時に `human` を選べる。使ってみて決める |
| Q8 | 日次上限の既定値（$20）とタイムゾーン | 初回起動で確認する UI を UI フェーズで用意 |

### 7.3 リードの決定と T0 で入れた差分（T0 Core の実装時に追記）

リードの決定：Q1 は既存の偽 Anthropic API の契約テスト（`runtime/claude/contract/`）だけで確かめる（実 API は呼ばない。T5）。Q3 は深さ 1。Q5 は `croner` の追加を承認。Q8 は初回の確認を出さず、既定 $20 のまま黙って適用し、後で費用メーターに出す。

T0 で仕様から足した・変えたもの（各トラックはこれを前提にする）：

| # | 差分 | 理由 |
|---|---|---|
| C1 | `SessionStateService.isWorkSettled(sessionId)` を契約に足し、Core が実装（`home/tree.ts`）。「終わっていない Task」は子孫が担当、または子孫が作成した Task | `work` の失効（§1.8）を T0 で動かすため。T7 は差し替えてよい |
| C2 | `work` の失効の判定は Run の終了（その会話と祖先）と `session.state_changed` のとき。起動時はしない | 再起動で失効させない（D17）。T7 の状態イベントが来れば自動で効く |
| C3 | イベント `artifact.updated { artifact, changes }` を足した（`ext/outputs.ts`） | `review` の変化を UI が追えるように |
| C4 | `AttentionRefs.taskId` を足した | 失敗 / レビュー待ちの Task から作る出番の重複除け |
| C5 | diff 成果物の `source` の既定は `workspace_diff`（他は `published`） | 既存の diff はすべて worktree から記録したもの |
| C6 | `AgentEvent.usage.phase` は省略可（省略 = `final`） | 既存のランタイムを壊さない |
| C7 | `task.wait` / `integration.wait` の `tool: false` は T1 が mock の指揮役を書き直すときに `api.ts` の 2 行で行う | 今外すと現行の `mock/orchestrator` と e2e が壊れる |
| C8 | `maxConcurrentRuns` / `autoResumeOrchestrators` は残し、新しい名前（`maxConcurrentAgents` / `autoResume`）は無ければ旧値を読む（`core/config.ts`） | 実行枠の 2 系統化（T1）まで RunManager は旧設定で動く |
| C9 | §3.7 の導出は `home/state.ts` の `deriveSessionState`（純関数）として Core が書き、起動時に一度だけ全会話へ適用 | §1.12 の「state は一度だけ計算」に必要。T7 が引き継ぐ |
| C10 | 一度だけのバックフィルは `schema_migrations` に `backfill/<module>/<name>` で記録（`runOnce`）。バックアップは `VACUUM INTO` で `acc.sqlite.bak-<DAEMON_VERSION>`（重複は `-2`…）、既存の DB で作り直しのマイグレーションが未適用のときだけ | WAL を含む一貫した複製。新規の DB には不要 |
| C11 | `Session.cost.source` は `treeUsd` に含めた行のうち最も弱いもの | `ownUsd` と `treeUsd` に 1 つの source しかないため |
| C12 | `ledger.record` は T5 まで何もしない。台帳のバックフィルは毎回の起動で冪等に走るので、終わった Run は次の起動で台帳に入る | 呼び出し位置（`runs/usage.ts`）だけ先に固定 |
| C13 | `outputs` モジュール（スタブ）を Core が足した。`project.inspectFolder` も projects にスタブ登録 | 全サービス・全メソッドがそろった状態でトラックを始めるため |
| C14 | `SpawnerService.spawn(params, actor, opts?)` の `opts` = `{ scheduleId, scheduledFor, trigger }`。`StartRunInput.trigger` を足した | 定期実行（T6）が spawner を通るため |
| C15 | `CallScope.sessionIds` は agent すべてに効く（`session.*` の scope が返す）。人間・system は対象外 | §1.8 の「agent は自分か子孫」 |
| C16 | `session.list` の `rootsOnly` / `parentSessionId`、`session.messages` の `streaming`（streams のスタブ経由）、`Project.folderPath` の保存は Core が配線済み | 引数を受けて黙って無視しないため |

T3（成果物とコードの工程）で仕様から足した・変えたもの：

| # | 差分 | 理由 |
|---|---|---|
| T3-1 | `Integration.preApprovedBy`（`Actor`、nullable・optional）を `domain.ts` に足した（共有ファイル、追加のみ） | §3.5 の「`preApprovedBy` を記録」に型がなかった |
| T3-2 | 自動の反映は「採用が始めた試行」だけ。再実行・Integrator の解消後の試行は承認を待つ | 採用したのはその時点のコード。後から入ったコードを人が見ずに反映しない |
| T3-3 | `accept` は種類を問わず人間だけ（§2.2 は「コードの accept は人間のみ」） | §3.9 の指揮役プリセットが「redo だけ」。`reviewBy: human` を AI が代わりに採用すると意味がない |
| T3-4 | finalize は「公開済み」と「worktree のコードの変更」を両方残す（優先順位は並び順と、書き込み・最後の本文を使うかの判断） | 文書を公開してもコードの変更は反映の判断が要る |
| T3-5 | 統合結果の diff は `role: evidence` | 子の変更と二重に「採用」の対象に見えないように |
| T3-6 | 早送りできなかった採用は `awaiting_approval` ＋ `error.code: apply_failed` ＋ 出番 review（子の会話） | 人が反映先を片付けてから `integration.approve` で続けられる |
| T3-7 | `redo` は `task.retry` を依頼者の actor で呼ぶ。agent は `task.spawnWorker` の権限で判定される（`assertCanSpawnWorker`） | T2 が `session.spawn` の子の判定（`assertCanSpawnChild`）に揃えるまでの継ぎ目。T1 の指揮役プリセットで redo するには T2 側の対応が要る |
| T3-8 | `done` の Task の成果物を redo すると Task を `review` に戻してから再実行する | 既定で人の確認が要らない成果物（`reviewBy: none`）も依頼者がやり直せるように |
