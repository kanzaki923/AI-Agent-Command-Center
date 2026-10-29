# 2026-10-29 本物の LiteLLM Proxy を挟んだ契約テスト（上流は偽 Anthropic API）

これまで LLM の 2 つの経路は「LiteLLM のふりをする偽物」でしか試していなかった。本物の LiteLLM Proxy をローカルで動かし、その上流を既存の偽 Anthropic API（`runtime/claude/contract/fakeAnthropic.ts`）に向けて、本物がリクエスト・レスポンスをどう作り替えるかを確かめた。費用・本物の認証情報・外部への通信はなし。

## 版と構成

- LiteLLM **1.106.6**（`litellm[proxy]`、PyPI から使い捨ての venv に。Python 3.14.3 で動いた）、tiktoken 0.14.0
- Claude Agent SDK 0.3.312 ＋ 同梱 CLI 2.1.312（win32-x64）、Node 22、Windows 11
- LiteLLM は `127.0.0.1` のみ、ダミーのマスターキー、`LITELLM_TELEMETRY=False`・`LITELLM_LOCAL_MODEL_COST_MAP=True`。環境変数は許可リスト（PATH・SYSTEMROOT など）＋一時 HOME / TEMP だけで、この機械の `ANTHROPIC_*` / `*_API_KEY` は渡さない。全モデルの `api_base` は偽 API、上流キーはダミー。`HTTPS_PROXY` / `HTTP_PROXY` は「すべて拒否して記録する」プロキシ（`NO_PROXY=127.0.0.1`）
- モデル：`claude-sonnet-4-5` / `team-sonnet`（→ `anthropic/claude-sonnet-4-5`）、`claude-sonnet-4-6`、`think-sonnet`（4.5 に `thinking: enabled` を付けたもの）、`flaky-sonnet`（エラー用の別デプロイメント）
- 再現：`llm/litellm-contract.test.ts`（11 件、約 35 秒）。`ACC_LITELLM_BIN` があるときだけ動く。手順は `docs/persistent/development.md` §6

## 準備で分かったこと

- **LiteLLM 1.106.6 の wheel に tiktoken の `cl100k_base` が入っていない**（`p50k` と `o200k` だけ）。LiteLLM は Anthropic へのチャット呼び出しでもこれを使うので、オフラインでは最初の呼び出しが `openaipublic.blob.core.windows.net` からのダウンロードを試み、失敗して **HTTP 500** になる（拒否プロキシに 15 回の接続試行が記録された）。外に出られない環境に LiteLLM を置くときは要注意。テストでは、古い LiteLLM の wheel（PyPI）に同梱されていた同じファイル（tiktoken の期待する SHA-256 と一致）をキャッシュに置き、`ACC_LITELLM_TIKTOKEN_CACHE` → `CUSTOM_TIKTOKEN_CACHE_DIR` で渡した。
- 起動は約 11 秒。それ以外の外向き通信は 0 件（全テストで拒否プロキシの記録が空）。

## 1. デーモンの LLM Gateway（`/chat/completions` → LiteLLM → Anthropic `/v1/messages`）

| 項目 | 観察 | 我々の扱い |
|---|---|---|
| テキストのストリーミング | Anthropic の text_delta がそのまま OpenAI の `delta.content` に。最初のチャンクに `role` | ○ |
| ツール呼び出し | `tool_calls` は 1 チャンク目に id と name、引数は `input_json_delta` の断片ごと。`task__get` などの `__` 名はそのまま往復。上流には Anthropic の `tools`（`input_schema`、`type: custom`）として届き、Control API の全ツールが `type: object` のスキーマで渡った | ○ |
| ツール結果 | `role: tool` は上流で `tool_result` に変換される | ○ |
| finish_reason | `end_turn` → `stop`、`tool_use` → `tool_calls`、`max_tokens` → `length` | ○ |
| usage | 最後のチャンク（`choices: [{delta: {}}]`）に `usage`。`prompt_tokens` は input ＋ cache 読み ＋ cache 書き（100 + 5000 + 2000 = 7100）、`cache_read_input_tokens` などの内訳つき | ○（Claude ランタイムと同じ数え方） |
| 費用 | **`usage.cost` に LiteLLM が計算した額**（価格表どおり、キャッシュ分も含む）。ストリームでは `x-litellm-response-cost` ヘッダは送られない（`-original` などの内訳ヘッダは 0.0）。エラー時のヘッダは `0` | ○（`usage.cost` を `reported` として使う既存の実装のまま。Budget の settle もこの額になることを確認） |
| `max_tokens` | 送らなければ LiteLLM がモデルの上限（Sonnet 4.5 で 64000）を付ける | 参考 |
| thinking（LiteLLM 側でモデルに `thinking` を設定） | `reasoning_content` と `thinking_blocks`（断片、最後に署名だけの断片）で流れる。**ツール呼び出しの次のリクエストで、assistant のターンに thinking ブロックが付かず、`thinking` は有効のまま上流に送られた** | ✕ → 修正（下記）。本物の API はこれを 400 で拒否する |
| LiteLLM にないモデル | **HTTP 400**「Invalid model name passed in model=…」（404 ではない）。上流には届かない | ✕ → `llm_model_not_found` と日本語の説明に |
| 上流の 400 / 401 / 404 | ステータスはそのまま。本文は `litellm.BadRequestError: AnthropicException - b'{…}'` ＋「LiteLLM: model group … No fallback was attempted.」。LiteLLM は再試行しない | △ → 上流のメッセージだけを取り出す |
| 上流の 429 / 500 / 529 | LiteLLM が計 3 回送ってから返す（約 5〜6 秒）。529（overloaded）は **500** になる | ○（Gateway は再試行しない。二重の再試行を避ける） |
| 上流の 401 / 404 の後 | LiteLLM がそのデプロイメントを約 5 秒止め、次の呼び出しは上流に届かず **429**「No deployments available … in cooldown」 | △ → 「数秒止めています」と説明 |
| 上流のストリームが止まる | LiteLLM は開いたまま待つ（`x-litellm-timeout: 6000.0`、既定 6000 秒） | ✕ → 無応答タイムアウト |
| `/models` | マスターキーで `model_list` の名前が返る | ○ |
| 自分のキーの誤り | DB なしの LiteLLM では 400「No connected db.」（DB ありなら 401 のはず。未確認） | 参考 |

## 2. Claude Agent SDK（同梱 CLI → LiteLLM `/v1/messages` → Anthropic）

| 項目 | 観察 | 想定どおりか |
|---|---|---|
| 経路 | CLI は `POST /v1/messages?beta=true`（Bearer のダミーマスターキー）。LiteLLM は `/v1/messages`（クエリなし）へ、自分の上流キーを `x-api-key` で、`user-agent: litellm/1.106.6` で送る。count_tokens など他のエンドポイントは呼ばれない | ○ |
| beta ヘッダ | CLI の `anthropic-beta`（`claude-code-20250219`、`interleaved-thinking`、`context-management`、`advanced-tool-use`、`thinking-token-count`、`thinking-display-updates`、auto mode では `afk-mode`・`dangerous-tool-use`）は**並べ替えられて全部そのまま**上流へ | ○ |
| ボディ | `thinking`（`display: updates` も）、`context_management`、`metadata`、`system`、`tools`（`defer_loading` つき）、`stop_sequences`、`temperature`、未知のフィールド `safeguards` まで素通し。`model` はデプロイメントの名前に置き換わる | ○ |
| 別名（`team-sonnet` → Sonnet 4.5） | CLI は別名を最新モデル扱いにして `thinking: adaptive` と `output_config`（effort）を送るが、**LiteLLM はデプロイメントのモデルに合わせて `thinking: {type: enabled, budget_tokens: 4096}` に書き換え、`output_config` を落とした**。`claude-sonnet-4-6` では `output_config` が残った | ○（偽 API 直結の調査で心配した「別名に adaptive が拒否される」は LiteLLM が吸収する。テストで固定） |
| 費用 | CLI の見積もり（`costSource: estimated`、別名は `unknown`）。LiteLLM の算出額は Anthropic 形式のストリームには載らず、CLI からは取れない | 変わらず |
| ToolSearch → MCP | `ToolSearch` の結果の `tool_reference` ブロックと、`defer_loading: true` の `mcp__acc__task_get` がそのまま往復し、呼び出しはディスパッチャまで届いた | ○ |
| auto mode（`CLAUDE_CODE_AUTO_MODE_MODEL=claude-sonnet-4-6`） | 分類器の別リクエスト（tools なし、`max_tokens: 64`、`stop_sequences: ["</block>"]`、`temperature`）が LiteLLM を通って届き、許可なら実行、拒否なら 2 段目まで行って `permission_denied`。既定の分類器名 `claude-sonnet-5` も model_list にあれば通る | ○ |
| `safeguards`（`CLAUDE_CODE_AUTO_MODE_SERVER` を外す） | `safeguards` フィールドと beta は上流まで届いた。偽 API は `safeguard_results` を返さないので、CLI は従来どおり自前の分類器に切り替えて警告を出した | △（本物の Anthropic が返したものを LiteLLM が CLI へ返すかは未確認） |
| 上流の 400 | CLI は数回送り直してから失敗。`result` は「API Error: 400 litellm.BadRequestError: AnthropicException - {…}\n\nLiteLLM: model group …」 | △ → 包みを外す |
| LiteLLM にないモデル | 400「anthropic_messages: Invalid model name …」。CLI の assistant エラーは `model_not_found` ではなく `unknown` | ✕ → 「LiteLLM にモデル「…」がありません」 |
| 上流の 401 | LiteLLM が 401 をそのまま返し、CLI は `api_retry`（`authentication_failed`）。我々は最初の再試行で止める | ○ |
| 上流の 429 / 529 | **再試行が掛け算になる**：CLI の 1 回ごとに LiteLLM が 3 回送る。CLI は最大 10 回、指数的に待つので、90 秒で上流に 21 回届いた（CLI の 7 回目）。529 は CLI には 500（`server_error`）として見える。`api_retry` が届くので無応答タイムアウトにはならない | △（費用は発生しないが、レート制限中の負荷が増える。下記「残り」） |
| ストリームが止まる | 我々の無応答タイムアウトで止まる（LiteLLM 経由でも同じ） | ○ |
| 子プロセス・外向き通信 | 残らない・0 件 | ○ |

## 直したこと

- **無応答タイムアウト**（`llm/openai.ts`）：LiteLLM から何も届かない時間（応答ヘッダ待ちを含む）が `idleTimeoutMs`（既定 5 分）を超えたら打ち切り、`llm_timeout`「LLM から 5 分以上応答がないため停止しました」。呼び出し側の中断は従来どおり AbortError。これまではチャット・Orchestrator の Run が最長 6000 秒止まり続けた。
- **LiteLLM のエラー文**（新規 `llm/gatewayErrors.ts`）：包み（`litellm.XxxError: …Exception - b'…'`、`LiteLLM: model group …`、`Handle with …`）を外して上流のメッセージだけにする。LiteLLM にないモデル（400）は `llm_model_not_found` と「LiteLLM にモデル「x」がありません。LiteLLM の model_list と、設定・チャットのモデル名を確認してください」、cooldown の 429 は「数秒間止めています」。他は 401 / 403・429・5xx ごとに日本語の説明。Claude ランタイムの失敗理由（`claude/normalize.ts`）も同じ関数を通す。
- **thinking ブロックの往復**（`llm/openai.ts`・`types.ts`・`gateway.ts`・`toolLoop.ts`）：`thinking_blocks` の断片を署名つきのブロックにまとめ、ツールループの次の呼び出しで assistant メッセージに `thinking_blocks` として付ける（LiteLLM が Anthropic の thinking ブロックに戻すことを確認）。メモリ上だけで、セッション履歴には保存しない。偽 API に、本物の規則（thinking 有効時、ツール使用で終わる最後の assistant ターンは thinking ブロックで始まること）をまねる `strictThinking` を足し、修正を外すとテストが 400 で落ちることを確かめた。
- **テスト**：本物の LiteLLM を起動するヘルパー `runtime/claude/contract/litellmProxy.ts`、契約テスト `llm/litellm-contract.test.ts`（任意）。常に回る単体テスト（`llm/llm.test.ts` の LiteLLM のエラー文・無応答・thinking ブロック、`runtime/claude.test.ts` の失敗理由）に観察した形を写した。偽 API に `configure()`（1 つの LiteLLM を複数のテストで共有するため）。

## 本物の Anthropic でないと分からないこと

- 本物の thinking の署名の検証（偽 API は署名を見ない）と、`redacted_thinking` の往復。
- `safeguards` に対する `safeguard_results` が LiteLLM を通って CLI に返るか（返ればサーバー側レビューになり、分類器の別リクエストと課金がなくなる）。
- 本物の分類器の判断、本物のモデルが ToolSearch で `mcp__acc__*` を探してから呼ぶか。
- Control API のツールのスキーマを本物の Anthropic が全部受け付けるか（LiteLLM はそのまま `input_schema` にした。偽 API は検証しない）。
- 本物の価格での `usage.cost` と、Anthropic 側の課金との一致。キャッシュ 5 分 / 1 時間の内訳。
- DB ありの LiteLLM（仮想キー・予算・spend ログ）での挙動。

## 残り・提案

- **予算の強制を LiteLLM にも任せる**：Claude ランタイムの費用は CLI の見積もりで、分類器の分も入らない。Worker ごとに LiteLLM の仮想キー（`max_budget` つき）を発行して渡せば、分類器を含む実際の消費を LiteLLM が止め、spend ログで正確な額を後から取り込める（DB ありの LiteLLM が必要）。
- **再試行の掛け算**：CLI には `CLAUDE_CODE_MAX_RETRIES` がある（バイナリで確認）。LiteLLM 経由のとき下げるか、LiteLLM 側の `num_retries` を CLI の経路だけ 0 にするかは、10 並列で 429 が出たときの実測で決める。今は変えていない。
- オフラインの LiteLLM には `cl100k_base` のキャッシュを用意する（運用の手順書に書く）。
