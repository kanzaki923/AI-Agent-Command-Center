# Claude Agent SDK 調査（2026-10-29）

最初のコーディングエージェント実行基盤として `@anthropic-ai/claude-agent-sdk` を Core Daemon（Node 22）に組み込み、LiteLLM Proxy 経由でモデルを呼ぶための調査メモ。実パッケージ（`0.3.312`、同梱 CLI `2.1.312`）を scratch にインストールし、`sdk.d.ts`・README・`sdk.mjs` を読んだ結果と、公式ドキュメント（code.claude.com の gateway 系ページ、LiteLLM docs）をまとめる。モデル呼び出しは一切していない。

## 1. パッケージ構成と実行モデル

- **CLI をサブプロセスとして起動する。** `query()` はネイティブ CLI バイナリを spawn し、stdio 上の stream-json と control request（`can_use_tool`、interrupt など）でやり取りする。SDK 本体（`sdk.mjs`）は薄いクライアント。
- **CLI は同梱。** `optionalDependencies` にプラットフォーム別パッケージ（`@anthropic-ai/claude-agent-sdk-win32-x64` など）があり、中身は `claude.exe`（win32-x64 で約 300MB）。解決は `require.resolve("@anthropic-ai/claude-agent-sdk-${platform}-${arch}/claude(.exe)")`。postinstall は不要で、`--ignore-scripts` でも動く。
  - pnpm でも optional deps は既定でインストールされる。`--no-optional` を使ってはいけない。
  - daemon をバンドルする場合、SDK は external にする。もしくは `pathToClaudeCodeExecutable` で明示パスを渡す。Tauri 配布では `claude.exe` を resource/sidecar として同梱し、パスを渡す形になる（サイズ約 300MB に注意）。
  - 同梱 CLI のバージョンは `package.json` の `claudeCodeVersion` と `manifest.json`（チェックサム付き）に書かれている。`claude.exe --version` は `2.1.312 (Claude Code)` を返した。
- エントリは `.`（フル）と `./core`（軽量。zod と MCP SDK を利用側のインストールから import する）。同じプロセスで両方を import しない。daemon では `./core` で十分。必要なのは `query` / `tool` / `createSdkMcpServer` / `startup` だけ。
- **peerDependencies**：`zod ^4.0.0`、`@anthropic-ai/sdk >=0.93.0`（型のみ。BetaMessage などの型を参照する）、`@modelcontextprotocol/sdk ^1.29.0`。こちらの zod v4 と衝突しない。検証時の解決結果は zod 4.6.7 / anthropic sdk 1.3.0 / MCP sdk 1.32.2。型は TS 5.0 以上が必要。
- **Windows**：ネイティブ実行に対応している。Git for Windows があると Bash ツールが Git Bash を使い（見つからない場合は `CLAUDE_CODE_GIT_BASH_PATH`）、無い場合は PowerShell ツールになる。サンドボックス（`sandbox` option）は Windows ネイティブでは非対応で、WSL2 のみ。したがって隔離は worktree と権限制御で担保する。
- Run ごとに CLI プロセスが 1 つ立つ。同時 10 Run なら 10 プロセス。起動遅延の対策として `startup()` / `prewarm()`（spare プロセスを先に起動しておく alpha API）がある。

## 2. `query()` の形

```ts
query({ prompt: string | AsyncIterable<SDKUserMessage>, options?: Options }): Query
// Query extends AsyncGenerator<SDKMessage, void>
//   interrupt(), setPermissionMode(), setModel(), close(), streamInput(), mcpServerStatus(),
//   getContextUsage(), rewindFiles(), stopTask(), backgroundTasks(), initializationResult() ...
```

control 系メソッド（`interrupt` など）は **streaming input（prompt に AsyncIterable を渡す形）のときだけ**動く。こちらは常に AsyncIterable で渡す。追加指示は同じ iterable に push すれば、マルチターンで同じ CLI プロセスを使い続けられる。

### 主要 Options

| option | 要点 |
|---|---|
| `cwd` | 作業ディレクトリ。worktree のパスを渡す。セッションの保存先も cwd に紐づく |
| `model` / `fallbackModel` | モデル名。LiteLLM の `model_name`（エイリアス）をそのまま渡せる |
| `systemPrompt` | `string` / `{type:'custom', prompt}` / `{type:'preset', preset:'claude_code', append?, excludeDynamicSections?, snapshot?}`。既定では初回に描画したものをセッションに記録し、resume 時は記録を再利用する（後から `append` を変えても効かない） |
| `permissionMode` | `'default' \| 'acceptEdits' \| 'bypassPermissions' \| 'plan' \| 'dontAsk' \| 'auto'`。**省略すると `'auto'`（モデルによる分類器判定）になり得る。必ず `'default'` を明示する** |
| `canUseTool` | `(toolName, input, {signal, toolUseID, suggestions?, blockedPath?, decisionReason?, title?, displayName?, description?, mcpServer?, agentID?, requestId, ...}) => Promise<PermissionResult \| null>`。**期限なしで待てる**（"permission prompts have no park deadline"）。`null` は返さない（返すとツールが永久にブロックされる） |
| `PermissionResult` | `{behavior:'allow', updatedInput?, updatedPermissions?}` または `{behavior:'deny', message, interrupt?}` |
| `permissionPrompts` | `'host'`（既定。canUseTool に問い合わせる）/ `'none'`（ask になる操作は即 deny） |
| `allowedTools` / `disallowedTools` / `tools` | `allowedTools` に入れたツールは**承認なしで自動実行**、`disallowedTools` はモデルのコンテキストから除外、`tools` は組み込みツールの基本セット（`[]` で全部無効） |
| `hooks` | `{ PreToolUse: [{ matcher?, hooks: [cb], timeout? }] }`。cb は `permissionDecision: 'allow'\|'deny'\|'ask'\|'defer'` と `updatedInput` を返せる。in-process で実行される |
| `mcpServers` | stdio/sse/http/sdk。`createSdkMcpServer({name, version, tools:[tool(name, desc, zodRawShape, handler)]})` で in-process ツールを作れる。ツール名は `mcp__<server>__<tool>` |
| `strictMcpConfig` | `mcpServers` 以外（`.mcp.json` やユーザー設定）の MCP を無視する |
| `settingSources` | `'user' \| 'project' \| 'local'` の配列。**省略すると全部読む**（ユーザーの `~/.claude/settings.json` の hooks や allow ルールまで効く）。`[]` で完全に分離。CLAUDE.md を読むには `'project'` が必要 |
| `abortController` | abort で query を止め、後片付けする |
| `resume` / `continue` / `forkSession` / `sessionId` / `resumeSessionAt` | `resume: <session_id>` で会話を再開する。`forkSession: true` で分岐 |
| `maxTurns` / `maxBudgetUsd` / `taskBudget` | 上限に達すると `error_max_turns` / `error_max_budget_usd` の result を返す。`maxBudgetUsd` は CLI 側の見積額に基づく |
| `env` | **指定すると子プロセスの環境を丸ごと置き換える**（マージしない）。PATH・SystemRoot・USERPROFILE・TEMP などは自分で入れる |
| `pathToClaudeCodeExecutable` / `executable` / `spawnClaudeCodeProcess` | バイナリパスの明示、spawn 方法の差し替え |
| `includePartialMessages` | `stream_event`（生の Messages API ストリームイベント）を流す |
| `stderr` / `debug` / `debugFile` | CLI のログ |
| `persistSession` / `sessionStore` | transcript の保存を制御する（既定ではローカル jsonl に保存） |
| `thinking` / `effort` | `{type:'adaptive'}` など |

### ストリームされるメッセージ（`SDKMessage` の主要部分）

| type / subtype | 中身 |
|---|---|
| `system` / `init` | `session_id`、`model`、`tools[]`、`mcp_servers[{name,status}]`、`permissionMode`、`cwd`、`claude_code_version`、`capabilities` |
| `stream_event` | `event: BetaRawMessageStreamEvent`（message_start / content_block_start / content_block_delta(`text_delta` / `thinking_delta` / `input_json_delta`) / message_delta(usage) / message_stop）。`parent_tool_use_id` が付く |
| `assistant` | `message: BetaMessage`。ストリーム時は **content ブロック 1 つにつき 1 メッセージ**で届き、`message.id` は同じ API 応答の中で共通。`tool_use` ブロックには `id/name/input` がある。`parent_tool_use_id` が非 null ならサブエージェントのメッセージ。`error?: 'rate_limit' \| 'authentication_failed' \| ...` |
| `user` | `message.content` に `tool_result`（`tool_use_id`, `content`, `is_error`）。`tool_use_result` に構造化された結果。`isSynthetic` |
| `result` | ターンごとに 1 つ届き、ターン完了の合図になる。`subtype: 'success' \| 'error_during_execution' \| 'error_max_turns' \| 'error_max_budget_usd' \| ...`、`is_error`、`result`（success 時の最終テキスト）、`errors[]`（エラー時）、`num_turns`、`duration_ms`、`total_cost_usd`、`usage`、`modelUsage`、`permission_denials[]`、`session_id` |
| その他 | `system/permission_denied`、`system/api_retry`、`compact_boundary`、`tool_progress`、`task_*`（サブエージェントやバックグラウンドタスク）、`rate_limit_event` など。未知の型は無視する |

## 3. コストと使用量

- `result.total_cost_usd`：**CLI がトークン数と組み込みの定価表から計算した見積額**で、請求額ではない。streaming input 時は累積値なので、最新の result を読む（足し合わせない）。
- `result.modelUsage: Record<model, {inputTokens, outputTokens, cacheReadInputTokens, cacheCreationInputTokens, webSearchRequests, costUSD, contextWindow, maxOutputTokens, canonicalModel?, provider?, costBasis?: 'list'\|'managed'\|'unknown'}>`：サブエージェントや compaction も含む。会計にはこちらを使う。
- `result.usage` はメインループだけ。
- **LiteLLM のエイリアス名だとモデルが認識されず、`costBasis: 'unknown'`（既定モデルの単価で推測）になり得る。** architecture.md の分類に合わせると、SDK の値は `estimated` として扱う。`reported` は LiteLLM 側（spend logs / virtual key の spend）から取る必要がある。
- ターン途中の消費は `stream_event` の `message_start.message.usage` / `message_delta.usage` から API 呼び出しごとに積算できる。これで Budget の reserve を超えそうなときに `interrupt()` できる。

## 4. LiteLLM への接続

```ts
env: {
  ...baseEnv,                                  // process.env から ANTHROPIC_* / CLAUDE_* を除いたもの
  ANTHROPIC_BASE_URL: litellmUrl,              // 例: http://127.0.0.1:4000（/v1 は付けない）
  ANTHROPIC_AUTH_TOKEN: litellmKey,            // Authorization: Bearer。ANTHROPIC_API_KEY なら x-api-key
  ANTHROPIC_DEFAULT_HAIKU_MODEL: smallModel,   // タイトル生成などのバックグラウンド呼び出し先を固定
  CLAUDE_CODE_SUBAGENT_MODEL: subagentModel,   // 任意
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
  CLAUDE_AGENT_SDK_CLIENT_APP: "acc/<version>",
}
```

- LiteLLM は Anthropic 形式の `/v1/messages` と、任意の `/v1/messages/count_tokens` を提供する。`model` は LiteLLM の `model_name` と完全一致させる。
- 注意点（公式 gateway 互換ガイドと LiteLLM の記述から）：
  - `anthropic-beta` と `anthropic-version` はそのまま転送する必要がある。上流が Bedrock や Vertex で beta を拒否して 400（`invalid beta flag` / `Extra inputs are not permitted` / `context_management`）になる場合は `CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS=1` を設定する。設定ページで切り替えられるようにしておくとよい。
  - 認識できないモデル ID（エイリアス）には adaptive thinking・effort・context_management など最新の全機能を送る。上流がそれらを受け付けないと 400 になる。CLI 側の設定 `modelOverrides` で実モデル ID に対応づけられる。
  - コンテキスト窓は未知モデルだと 200K と仮定される。LiteLLM 側でもっと小さく制限している場合、自動 compaction が効かない。対策は `CLAUDE_CODE_AUTO_COMPACT_WINDOW` と `CLAUDE_CODE_MAX_OUTPUT_TOKENS`。
  - `cache_control` を落とす proxy だとプロンプトキャッシュが効かず、コストが跳ね上がる。LiteLLM の互換マトリクス（v1.106.1 × CC 2.1.302）では Anthropic・Bedrock・Vertex・Azure で caching / tool use / thinking / streaming は ✅。
  - カスタム base URL では MCP の tool search が無効になり得る（全 MCP ツールのスキーマが最初から載る）。こちらの in-process ツールは少数なので問題ない。
  - `x-claude-code-session-id` ヘッダが付く。`ANTHROPIC_CUSTOM_HEADERS`（`Name: Value` を改行区切り）で Run ID などを付ければ、LiteLLM 側の spend logs と突き合わせる手がかりになる（LiteLLM のタグ / metadata ヘッダの名前は要検証）。
  - ユーザーが claude.ai にログインしていても、`ANTHROPIC_AUTH_TOKEN` が優先される。

## 5. 推奨アダプタ設計（`packages/daemon/src/runtime/`）

### インターフェース

```ts
interface AgentRuntime {
  readonly id: "claude-agent-sdk" | "mock" | string;
  start(run: RuntimeRunSpec, hooks: RuntimeHost): RuntimeHandle;
}

interface RuntimeRunSpec {
  runId: string;
  cwd: string;                     // worktree
  prompt: string;
  model: string;                   // LiteLLM model_name
  systemAppend?: string;
  resumeToken?: string;            // 前回の SDK session_id
  limits: { maxTurns?: number; maxBudgetUsd?: number };
  tools: { allow: string[]; deny: string[] };  // Capability から導出したもの
  extraTools?: SdkMcpToolDefinition[];          // Control API から生成した LLM ツール
}

interface RuntimeHost {
  // 承認フロー。Run を awaiting_approval にし、人間 / Orchestrator の決定で resolve する
  requestApproval(req: { toolUseId: string; toolName: string; input: unknown; title?: string;
                         description?: string; blockedPath?: string; signal: AbortSignal })
    : Promise<{ allow: true; updatedInput?: unknown } | { allow: false; reason: string; interrupt?: boolean }>;
  // 決定的なポリシー判定（Capability・パス境界）。同期的に近い短時間で返す
  checkPolicy(toolName: string, input: unknown): "allow" | "deny" | "ask";
}

interface RuntimeHandle {
  events: AsyncIterable<RuntimeEvent>;
  send(text: string): void;        // 追加指示（streaming input に push する）
  cancel(): Promise<void>;         // interrupt() → 猶予後に close()
  readonly resumeToken: Promise<string | undefined>;
}

type RuntimeEvent =
  | { type: "session"; resumeToken: string; model: string; tools: string[] }
  | { type: "text_delta"; messageId: string; text: string; parentToolUseId: string | null }   // 永続化しない
  | { type: "message"; messageId: string; text: string; parentToolUseId: string | null }      // 確定テキスト
  | { type: "tool_call"; toolUseId: string; name: string; input: unknown; parentToolUseId: string | null }
  | { type: "tool_result"; toolUseId: string; isError: boolean; content: unknown }
  | { type: "approval_request"; approvalId: string; toolUseId: string; toolName: string; input: unknown }
  | { type: "usage"; source: "estimated"; costUsd: number; byModel: Record<string, ModelUsage> }
  | { type: "done"; status: "completed" | "failed" | "cancelled"; reason?: string; result?: string }
  | { type: "error"; code: string; message: string };
```

### 実装方針

1. **入力**：`prompt` には AsyncIterable（内部キュー）を渡す。初回 prompt を push し、`send()` で追記する。Run 完了時（`result` を受け取り、続きの入力もない）にキューを閉じる。
2. **固定オプション**：`permissionMode:'default'`、`settingSources: []`（初期。CLAUDE.md が必要なら `['project']`。その場合 repo の allow ルールが効いてしまう点は 3. の hook で抑える）、`strictMcpConfig: true`、`includePartialMessages: true`、`systemPrompt: {type:'preset', preset:'claude_code', append}`、`env` は明示的に組み立てる、`pathToClaudeCodeExecutable` は設定可能にする。
3. **権限の強制は二段にする**（CLAUDE.md の「制約は Core Daemon が強制する」を満たすため）：
   - `hooks.PreToolUse`：`checkPolicy()` で決定的に判定する。Capability 外やパス境界外は `deny`、Capability で許されていれば `allow`、それ以外は `ask`。settings の allow ルールより前に評価され、`ask` を返せば canUseTool に回る（`ask` が project settings の allow ルールより優先されるかは**要検証**）。
   - `canUseTool`：`approval_request` イベントを出してから `host.requestApproval()` を await する。`signal` が abort されたら承認を取り下げて deny を返す。期限はないので、awaiting_approval の待機はこちら側で管理する。`allowedTools` には読み取り系だけを入れ、書き込み系は hook / 承認を通す。
4. **イベント正規化**：
   - `system/init` → `session`（`session_id` を resumeToken として Run に保存）
   - `stream_event` の `content_block_delta.text_delta` → `text_delta`（WS の `delta` フレームに流す）
   - `assistant` の text ブロック → `message`。`message.id` 単位で連結する。tool_use ブロック → `tool_call`
   - `user` の `tool_result` → `tool_result`
   - `result` → `usage`（`modelUsage` と `total_cost_usd`、source は `estimated`）＋ `done`（success → completed、error_* → failed、interrupt 起因 → cancelled）
   - CLI の異常終了（イテレータが throw した）→ `error` ＋ `done(failed)`。stderr はリングバッファに残して添付する。
5. **キャンセル**：`interrupt()` を呼び、数秒待っても result が来なければ `close()`（または `abortController.abort()`）。daemon 再起動時は Run を `interrupted` にし、resumeToken があれば「再開」を提示する。
6. **再開**：`resume: resumeToken` と**同じ cwd（worktree）**で起動する。分岐させたいときは `forkSession: true`。
7. **予算**：Run 開始時に reserve し、`stream_event` の usage を積算して見積額が reserve を超えたら interrupt する。`maxBudgetUsd` は保険として二重にかける。確定額は `result.modelUsage`（estimated）で、LiteLLM から reported が取れたら上書きする。LiteLLM の virtual key に max_budget を設定すれば最終防壁になる。
8. **in-process ツール**：Control API のメソッド定義から `tool(name, description, zodShape, handler)` を生成して `createSdkMcpServer({name:'acc'})` に載せる。handler は Actor `agent(runId)` としてディスパッチャを通すので、Capability はディスパッチャ側で強制される。
9. **テスト**：mock runtime は同じ `RuntimeEvent` を出す。SDK アダプタ自体は `normalize(SDKMessage) → RuntimeEvent[]` を純関数に切り出し、記録した SDKMessage の fixture でユニットテストする。実モデル呼び出しは手動の E2E だけで行う。

## 6. 未検証・今後確認すること

- PreToolUse hook の `ask` が project/user settings の allow ルールより優先されるか
- LiteLLM 側でリクエストに Run を対応づけるヘッダ（タグ / metadata）の名前と、spend 取得 API
- Windows で `env` を最小構成（PATH・SystemRoot・USERPROFILE・TEMP・APPDATA・LOCALAPPDATA）にしたとき、CLI が正常に起動するか
- `settingSources: []` の状態で、CLI がユーザーの `~/.claude`（認証情報・transcript 保存先）をどこまで使うか。必要なら `CLAUDE_CONFIG_DIR` を `ACC_HOME` 配下に分離する
- 10 並列時のメモリと起動時間、`prewarm()` の効果

## 7. 検証に使った probe

scratch に `@anthropic-ai/claude-agent-sdk@0.3.312` と `zod@4` を入れ、`query` / `tool` / `createSdkMcpServer` / `CanUseTool` / `SDKMessage` の正規化関数を書いて `tsc --strict`（`skipLibCheck: false` でも）が通ることを確認した。`query()` を組み立てるだけで iterate はしていない。

参考：
- https://code.claude.com/docs/en/llm-gateway-connect
- https://code.claude.com/docs/en/llm-gateway-protocol
- https://code.claude.com/docs/en/setup
- https://docs.litellm.ai/docs/tutorials/claude_responses_api
- https://docs.litellm.ai/docs/tutorials/claude_agent_sdk
- https://litellm.vercel.app/docs/claude_code_compatibility
