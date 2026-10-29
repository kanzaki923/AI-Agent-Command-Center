# 2026-10-29 Claude Agent SDK を本物の CLI で確かめた結果

`20261029_agent-sdk-public-check.md` の「直すべきもの」1〜8 を、推測ではなく実機の挙動で確かめた。本物の SDK（`@anthropic-ai/claude-agent-sdk` 0.3.312）と SDK 同梱の本物の Claude Code CLI（**2.1.312**、win32-x64）を、ローカルの偽 Anthropic API に向けて `ClaudeAgentSdkRuntime` ごと動かした。費用・ネットワーク・本物の認証情報はなし。

## やり方

- **偽 API**（`packages/daemon/src/runtime/claude/contract/fakeAnthropic.ts`）：`127.0.0.1` のエフェメラルポート。`POST /v1/messages` は本物と同じ SSE（`message_start` → `content_block_start/delta/stop`（text / thinking + signature / tool_use + `input_json_delta`）→ `message_delta`（usage + stop_reason）→ `message_stop`）、`stream` がなければ JSON、`/v1/messages/count_tokens`、それ以外は 404。台本は「受け取ったリクエスト → 返答」の関数の列（tool_result を見てから最終回答を返せる）。HTTP エラー、途中で止まるストリームも出せる。全リクエストを記録（認証ヘッダは `<redacted>`）。
- **隔離**（`contract/harness.ts`）：一時ディレクトリに HOME / USERPROFILE / APPDATA / LOCALAPPDATA / TEMP / `CLAUDE_CONFIG_DIR` を作り、一時 git リポジトリを cwd にする。親の環境は許可リストからだけ組み立てる（この機械の `ANTHROPIC_BASE_URL` などは渡らない）。`HTTPS_PROXY` / `HTTP_PROXY` を「すべて拒否して記録する」プロキシに向け、`NO_PROXY=127.0.0.1,localhost`。`settingSources: []`。トークンはダミー。
- **実行**（`contract/runner.ts`）：本物の SDK モジュールに記録用の tee を挟み（生のメッセージ、`canUseTool` と `PreToolUse` フックの呼び出しを記録）、`ClaudeAgentSdkRuntime.run()` を動かす。

### CLI が送ったもの

- 子プロセスの環境変数（名前のみ）：許可リスト（PATH、SYSTEMROOT など）＋ サンドボックスの HOME 系 / TEMP 系 / `CLAUDE_CONFIG_DIR` / プロキシ ＋ ランタイムが足す `ANTHROPIC_BASE_URL`、`ANTHROPIC_AUTH_TOKEN`、`ANTHROPIC_MODEL`、`ANTHROPIC_DEFAULT_HAIKU_MODEL`、`CLAUDE_CODE_SUBAGENT_MODEL`、`CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC`、`CLAUDE_CODE_DISABLE_BACKGROUND_TASKS`（今回追加）、`CLAUDE_AGENT_SDK_CLIENT_APP`。
- リクエストは **`POST /v1/messages?beta=true` だけ**。count_tokens、タイトル生成などの副次リクエスト、テレメトリ、自動更新はなし。プロキシへの接続試行は全シナリオで 0 件。ログインも求められなかった（init の `apiKeySource: "none"`）。
- ヘッダ：`authorization: Bearer <redacted>`（`x-api-key` はなし）、`anthropic-version: 2023-06-01`、`anthropic-beta: claude-code-20250219,interleaved-thinking-2025-05-14,context-management-2025-06-27,thinking-token-count-2026-05-13,advanced-tool-use-2025-11-20,thinking-display-updates-2026-08-18`、`user-agent: claude-cli/2.1.312 (external, sdk-ts, agent-sdk/0.3.312, client-app/acc/…)`、`x-app: cli`、`x-claude-code-session-id`、`x-stainless-*`。
- ボディのキー：`context_management, max_tokens(32000), messages, metadata, model, stream, system, thinking, tools`。`claude-sonnet-4-5` では `thinking: {type: enabled, budget_tokens: 31999}`。別名 `team-sonnet` では `thinking: {type: adaptive}` と `output_config`（effort）、beta に `effort-2025-11-24` などが増える。
- `tools` は Agent / Bash / Edit / Glob / Grep / Read / Write など＋ `DeferredToolPlaceholder`。MCP ツール（`mcp__acc__*`）や WebFetch などは**遅延読み込み**（ToolSearch 経由）でリクエストには載らない。`ENABLE_TOOL_SEARCH=false` を渡すと全部が直接載る。

## 観察結果

| # | シナリオ | 観察 | 想定どおりか |
|---|---|---|---|
| a | テキストのストリーミング | `stream_event` の text_delta → ブロックごとの `assistant` → `result`。thinking は `thinking_tokens` という system メッセージも出る。result に `total_cost_usd`、`modelUsage[model].costBasis: "list"`、`terminal_reason: "completed"`、`api_error_status: null` | ○（形は想定どおり） |
| a | 別名モデル（`team-sonnet`） | `costBasis: "unknown"`、`provider: "firstParty"`、`contextWindow: 200000`。最新モデル扱い（adaptive thinking） | ○（公開情報 3・7 のとおり）。コストは推測値 |
| b | `git status` / `ls` / `grep -rn` / `find -name` / `git log` / `cat .git/config` | **`canUseTool` を呼ばずに自動で許可** | ✕（ポリシーの「コマンドは常に承認」が効いていなかった。公開情報 1） |
| b | `git -c core.pager=cat log -1` | 自動で許可（`canUseTool` なし） | ✕（任意コマンドを走らせうる形が素通り） |
| b | `rm -rf build`、`echo hi > out.txt`、`find -delete`、`git config …` | `canUseTool` が呼ばれる（`blockedPath` つきのことがある。ワークスペース内のパスでも付く） | ○ |
| b | `cat ../outside/secret.txt`、絶対パスで外を読む | `canUseTool` が `blockedPath`（外のパス）つきで呼ばれる | ○ |
| c | ワークスペース内の Write / Edit | **`canUseTool` が呼ばれた**（ポリシーで許可） | ○（#493 の報告とは逆。この版では再現しない） |
| c | `.git/config` の Edit、`.git/hooks/` への Write | `canUseTool` が呼ばれ、ポリシーで承認に回った | ○ |
| c | ワークスペース外の Read / Write / Grep | `canUseTool` が呼ばれる | ○ |
| c | ワークスペース内の Read | 自動で許可 | ○（ポリシーも許可） |
| d | 検索ツール | init の `tools` に **Grep / Glob がある**（win32 の同梱 CLI）。ワークスペース内の Grep / Glob は自動で許可 | △（公開情報 2 の「native build では無い」はこの版・この OS では当たらない） |
| — | `Monitor`（コマンドを実行する）、`CronCreate`、`EnterWorktree`（cwd の下に別 worktree を作って移る）、`EnterPlanMode`、`Skill`、`TaskCreate` など | **すべて `canUseTool` なしで実行された**。`ListAgents` は同じ設定ディレクトリの他セッション名を返す | ✕（無人の Run とポリシーの外で動く） |
| e | AskUserQuestion | `canUseTool` が呼ばれて「ツール「AskUserQuestion」の使用を承認しますか」になり、承認するとツール結果は「The user did not answer the questions.」 | ✕（公開情報 5 のとおり） |
| e | AskUserQuestion / EnterPlanMode などは `canUseTool` を渡したときだけ init の tools に出る | — | 参考 |
| f | in-process MCP | init に `mcp_servers: [{name: "acc", status: "connected", source: "sdk"}]` と `mcp__acc__task_get`。呼び出しはディスパッチャまで往復した | ○ |
| f | `allowedTools` に MCP ツールを入れる | SDK が `CLAUDE_SDK_CAN_USE_TOOL_SHADOWED` 警告を毎回出す（canUseTool を素通り）。外すと `canUseTool` が呼ばれる | △ |
| f | ツールなしの MCP サーバ | init は `status: connected` のまま、ツールだけない。何も失敗しない | ✕（Control API なしで黙って動いてしまう） |
| — | `PreToolUse` フック | **自動許可されるツールも含め、全ツール呼び出しで呼ばれる**（サブエージェント内も）。`ask` を返すと CLI は `canUseTool` を呼ぶ。`deny` を返すと実行されず、モデルには「PreToolUse:Bash hook error: <理由>」が返る | ○（公開情報 1 の対応案が成立） |
| — | Agent ツール（サブエージェント） | 既定では**非同期**：「Async agent launched」がすぐ返り、main の result の後に通知ターンが来る。`CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1` なら終わるまで待つ | ✕（1 Run = 1 ターンの前提と合わない） |
| g | ストリーム途中の interrupt | 約 1 秒で `result`（`error_during_execution`、`terminal_reason: aborted_streaming`）。新しいセッションでは累計 0、`modelUsage: {}` | ○。中断した呼び出しの使用量は CLI 自身が数えない |
| g | 承認待ちの間の中断 | `canUseTool` へ interrupt つき deny を返すと `result`（`aborted_tools`）。それまでの呼び出しの使用量は入っている | ○ |
| g | ストリームが止まる | CLI は何も送らず待ち続ける（我々のタイムアウトがなければ終わらない） | ✕（公開情報 6） |
| g | 終了 | すべての中断・タイムアウトのあと、`claude.exe` の子プロセスは残らなかった（Windows） | ○（#403 / #425 / #444 は再現せず） |
| — | API 400 | CLI が数回送り直した後、`subtype: success` + `is_error: true`、`api_error_status: 400`、`terminal_reason: api_error`、`result: "API Error: 400 …"`。assistant に `error: "unknown"` | ○ |
| — | API 401 | `system/api_retry`（`error: authentication_failed`、`max_retries: 10`）を指数的な間隔で繰り返す。60 秒たっても終わらない | ✕（設定ミスで数分「再試行中」になる） |
| — | API 404（モデルなし） | assistant `error: model_not_found`、`api_error_status: 404` | ○ |
| h | 再開（正常） | 再開後の result は**前回までの累計を引き継いだ値**（1000 → 3000）。差分方式が正しい | ○ |
| h | result 直後に強制 `close()` → 再開 | 次の result は強制終了した Run の分も含む累計から続いた（= 累計は result の時点で保存済み） | ✕（公開情報 4 の「強制 close だと累計が保存されない」は当たらない。基準値を保存しないと二重計上になる） |
| h | API エラーの result | 再開したセッションでは累計を引き継いだ値（0 ではない）。新しいセッションでは 0 | △（0 のときだけ基準値を変えてはいけない） |
| h | 中断した Run の後の再開 | 中断した呼び出しは累計に入らない。累計はそれ以前から続く | ○ |
| — | result の未文書フィールド | `model_usage_since_last_result`（このターンの差分）、`subagent_stats`、`safety_stops` | 参考（型にないので使わない） |

## 直したこと

- **権限**：`hooks.PreToolUse` で全ツール呼び出しに `decideToolPermission` を適用（deny / ask / 何も返さない）。`canUseTool` は CLI が尋ねたときに同じポリシーで答える。`allowedTools` はやめた。ポリシーに `deny` を追加。
- **無人に合わないツール**：`AskUserQuestion`、`EnterPlanMode` / `ExitPlanMode`、`EnterWorktree` / `ExitWorktree`、`CronCreate` / `CronDelete` / `CronList`、`ScheduleWakeup`、`RemoteTrigger`、`Monitor`、`PushNotification` を `disallowedTools` で外し、ポリシーでも拒否（理由は「自律的に進めて、仮定は最終メッセージに書く」）。実機では「No such tool available」になる。
- **作業管理ツール**：`TaskCreate` / `TaskGet` / `TaskList` / `TaskUpdate` / `TaskStop`、`ToolSearch`、`Skill` は許可（フックで承認に回すと毎回の作業計画更新が承認待ちになるため）。
- **検索**：Grep / Glob はこの CLI にあり、ワークスペース内なら承認なし。加えて読み取りだけの Bash の狭い許可リスト（`runtime/commands.ts`）を純関数で判定（native build で Grep / Glob がない場合にも備える）。
- **サブエージェント**：`CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1`。サブエージェントのツールもフックと承認を通ることを確認。
- **費用**：`costSource` は `estimated`、`costBasis: unknown` があれば `unknown`。基準値は result を受け取った時点で保存し、累計が 0 のエラー result では変えない。
- **堅牢性**：無応答タイムアウト（既定 10 分、承認待ちは数えない）。interrupt → 入力を閉じる → 猶予後に close の順。中断後も、中断したターンの使用量だけは報告する。MCP ツールが init に出なければ日本語の理由で失敗。401 などの恒久的なエラーは最初の再試行で止める。再試行中の表示に回数と HTTP ステータス。assistant エラーの表を `sdk.d.ts` の全値に拡張し、`terminal_reason` と `api_error_status` も理由に使う。
- **テスト**：`runtime/claude.test.ts` の手書き fixture を、本物の CLI から記録したメッセージ列（`contract/recorded.ts`、`satisfies RecordedStream` で SDK の型に照らして検査）に置き換えた。契約テスト `runtime/claude/sdk-contract.test.ts`（約 20 秒）は通常の `pnpm test` に入れ、CLI がなければスキップ。

## 実際の LiteLLM / 実モデルでないと確かめられないこと

- **別名モデルの扱い**（公開情報 7）：別名は最新モデルとして adaptive thinking・effort・追加の beta を送る。LiteLLM がそれを受け付けるか、背後のモデル（Claude 以外を含む）が `thinking` / `context_management` / `output_config` を拒否しないかは偽 API では分からない。必要なら LiteLLM 側の設定か CLI の model overrides で調整する。
- **ツール検索**：MCP ツールと一部の組み込みツールは遅延読み込み（ToolSearch、`tool_reference`、`advanced-tool-use` beta）になる。gateway がこれを通すか、実モデルが ToolSearch で `mcp__acc__*` を探してから呼ぶかは未確認。だめなら `ENABLE_TOOL_SEARCH=false` を渡せば直接載る（偽 API では確認済み）。
- **実際の費用**：CLI の `total_cost_usd` は同梱の価格表による見積もり。正確な額は LiteLLM の spend で取る必要がある。キャッシュの 5 分 / 1 時間の内訳も本物の API の usage 次第。
- **実モデルの振る舞い**：AskUserQuestion を外したときに実モデルが自律的に進むか、読み取り許可リストの範囲で検索が足りるか、サブエージェントを待つと時間がかかりすぎないか。
- **他 OS**：Grep / Glob の有無（native build の changelog）と子プロセスの後始末は Windows でしか見ていない。契約テストを macOS / Linux で回せば分かる。
- **429 / 529 / 5xx の再試行**：CLI の再試行（最大 10 回）は試していない（時間がかかる）。再試行中は `api_retry` が届くので無応答タイムアウトにはならない。

## 再現

```sh
pnpm --filter @acc/daemon test:sdk-contract     # 契約テストだけ
pnpm --filter @acc/daemon record:sdk-fixtures   # 単体テスト用の記録を取り直す
```
