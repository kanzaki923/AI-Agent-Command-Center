# 2026-10-29 auto mode の判定の費用と、サーバー判定を既定にしたこと

`20261029_litellm-real.md` の続き。本物の Anthropic API を LiteLLM 1.106.6 経由で測った数字（ユーザーの許可を得た最小限の確認。今回の作業では本物へのリクエストは送っていない）と、偽 API（`runtime/claude/contract/fakeAnthropic.ts`）で CLI 2.1.312 の振る舞いを確かめた結果をまとめる。これを受けて `settings.autoMode.judge`（既定 `server`）を足した（architecture.md §2.10）。

## 1 回の判定の費用（本物、Sonnet 4.6 を分類器に）

| 判定の場所 | 別リクエスト | 1 回の費用 | 備考 |
|---|---|---|---|
| サーバー（`CLAUDE_CODE_AUTO_MODE_SERVER` を設定しない） | なし | 見える追加はなし | 本体のリクエストに `safeguards`。usage のトークン数は付けないときと同じ |
| 手元の分類器（`=0`）、キャッシュが冷えている | 1 件 | **$0.126** | 約 3.35 万トークンのキャッシュ書き込み |
| 手元の分類器、キャッシュが温かい（5 分 TTL） | 1 件 | **$0.0105〜0.0113** | 2 回目以降 |
| 手元の分類器、読み取りだけのコマンド（`node --version`・`git status --short`） | なし | 0 | `reason_type: subcommandResults` で分類器を通らずに許可 |

- **キャッシュは CLI のセッションをまたいで共有された。** 分類器のプロンプトの先頭が同じだから。`AUTO_MODE_SETTINGS` には Run ごとの文字列（worktree のパス、Task / Run の ID）を入れない（コメントと `claude.test.ts` のテストで固定）。
- この額は SDK の `total_cost_usd` に入らない（Budget は少なく数える。未対応のまま）。

## サーバー判定（本物）

- 本体の `/v1/messages` に `safeguards` が付き、応答の `message_delta.delta.safeguard_results` に `[{type: 'dangerous_tool_use', status: {type: 'available', tool_uses: {<toolu_id>: {type: 'evaluated', outcome: 'not_flagged'}}}}]` が返った。分類器の別リクエストはなし。LiteLLM は `safeguards` も `safeguard_results` も素通し。
- `tool_result_meta[].permission_decision.reason_type` は手元の分類器と同じ `classifier`。どちらが判定したかはここでは分からない。
- 読み取りだけのコマンドも判定された（手元の分類器なら通らないもの）。
- 公式の説明：サーバー判定は無料（"at no charge"）、手元の分類器のリクエストは通常のトークンとして課金（https://code.claude.com/docs/en/auto-mode-classifier-billing.md）。分類器のモデルは既定で Claude Sonnet 5、Sonnet 5.5 / Opus 5.5 を指定しても使わず既定に戻る（https://code.claude.com/docs/en/permission-modes.md）。→ 分類器のモデルは空（CLI の既定）を勧め、gateway で Sonnet 5 の名前が違うときだけ設定する。UI に既定のモデルは決め打ちしない。

## 偽 API で確かめたこと（CLI 2.1.312）

| 上流の答え | CLI の振る舞い | 我々の記録 |
|---|---|---|
| `safeguard_results` で `not_flagged` | 分類器なしで実行 | `judge: server` |
| `flagged`（`explanation` つき） | `permission_denied`（`decision_reason` が explanation）、ツールエラーで理由を返す | `judge: server`、理由はそのまま |
| `{type: 'unsupported'}`、または `safeguard_results` なし | `system/informational`（gateway が対応しないので分類器のリクエストは課金される、という英文）。以後そのセッションは `safeguards` を送らず手元の分類器 | `Run.permission.judge: client` と `note`、以後の判断は `judge: client` |
| なし、かつ分類器のリクエストが 400（LiteLLM にモデルがない） | `permission_denied`「… is temporarily unavailable, so auto mode cannot determine the safety …」、`decision_reason: Classifier unavailable`、`non_execution_kind: automode-unavailable` | 判定できない → その Run を規則に（承認は出ない） |

- `safeguard_results` は SDK の `stream_event`（`includePartialMessages`）にそのまま出る。判定した場所はここから取る（文書なし、任意扱い）。
- サーバー判定のときも `CLAUDE_CODE_AUTO_MODE_MODEL` は手元の予備の分類器に使われた（別名 `team-classifier` で確認）。公式の説明ではサーバー判定には使わない。
- 「判定できない」の文言は 3 種類あった（`could not evaluate`、`cannot determine the safety`、`Classifier unavailable`）。従来は 1 つ目しか見ておらず、分類器のモデルがないときに規則へ切り替わらない穴があった → 直した。

### `safeguards` の中身（サーバーに送られるもの）

本体のリクエストの `safeguards` は `[{type: 'dangerous_tool_use', classifier_context: {...}}]`。`classifier_context` には次が入っていた（パスとユーザー名は伏せる）：

- `v: 1`、`permission_mode: auto`、`platform`、`live_cwd`（worktree）、`home_dir`、`rule_roots`（各設定の場所）、`trusted_directories`（worktree と追加ディレクトリ、`network`）
- `rules`：`allow` / `deny` / `ask`（我々の `disallowedTools` が `deny` に `source: cliArg` で並ぶ）
- **`auto_mode`：我々のインライン設定がそのまま**（`environment` と `hard_deny` に `$defaults` ＋ `AUTO_MODE_SETTINGS` の文、`allow` / `soft_deny` は空）、`classify_all_shell: true`
- `user_identity`（**OS のユーザー名**）、`git_state`（ブランチ、clean か、変更の数、リモート）、`case_insensitive_paths`、`restricted`、`is_remote_mode` など

つまり、このアプリ向けの追加ルールはサーバー判定にも届く（ただしサーバーが実際にそれを使うかは文書になく、本物で拒否される場面は確かめていない）。サーバーには作業ディレクトリ・ホームのパス・OS のユーザー名・git の状態が送られる。`sdk-contract.test.ts` で `auto_mode` と `classify_all_shell` が届くことを固定した。リクエスト本文はログに出さない。

## 変えたこと

- `settings.autoMode.judge: 'server' | 'client'`（既定 `server`。古い設定ファイルも `server` になる）。`server` は `CLAUDE_CODE_AUTO_MODE_SERVER` を設定せず、LiteLLM 経由でも分類器のモデルなしで auto mode を使う。`client` は従来どおり `=0` で、LiteLLM 経由は分類器のモデルが必要。
- `tool.decided.judge` と `Run.permission.judge`（任意）。UI は判断者のツールチップと `おまかせ · Auto mode が判断（サーバー判定）`。
- 設定の `エージェントの権限` に `判定する場所` のラジオ（1 行ずつの説明）。
- 偽 API に `safeguards`（`safeguard_results` を返す / 返さない）を足し、契約テストに 5 件（サーバーで許可、サーバーで拒否、上流が非対応で手元に切り替え、分類器のモデルもなく規則に切り替え、送られる `safeguards` の中身）。

## まだ確かめていないこと

- サーバー判定の課金（API の usage には見えない。公式は無料と説明）。
- Bedrock / Vertex / Foundry を上流にした LiteLLM でサーバー判定が返るか（返らなければ手元の分類器に切り替わる。偽 API で確認済み）。
- 本物で拒否される場面（`flagged` の実際の形、`explanation` の中身、サーバーが `auto_mode` の追加ルールを効かせるか）。
- 本物の `unsupported` / `unavailable` の出方と、`unavailable`（`error` など）で CLI が手元に切り替えるか、その 1 件を拒否するか。
- Sonnet 5（CLI の既定）を分類器にしたときの 1 回の費用（今回は Sonnet 4.6 で測った）。
