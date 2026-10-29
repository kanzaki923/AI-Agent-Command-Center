# 2026-10-29 Claude Agent SDK 実装と公開情報の突き合わせ

`runtime/claude/` の実装（SDK 0.3.312）を、公式ドキュメント（code.claude.com の Agent SDK / LLM gateway 各ページ）と Web 上の報告（anthropics/claude-agent-sdk-typescript の issue、LiteLLM の docs と issue）と照合した。実機での確認はまだしていない。

## 結論

**「スタブで作ったが、本物はメソッドやペイロードが違った」という種類のずれは見つからなかった。**

- 入力側（`Options`、`canUseTool`、`SDKUserMessage`、`tool()`、`createSdkMcpServer()`）は SDK の型で検査されており、公式仕様とも一致している。
- 出力側（手書きで解析しているメッセージ）も、`system/init` の `session_id`、`stream_event`（生の Messages API イベント）、`result` の subtype・`usage`・`total_cost_usd`・`modelUsage` は公式の記述と一致した。

見つかったのは「形」ではなく「挙動の前提」のずれ。

## 直すべきもの（優先順）

| # | 内容 | 根拠 | 対応案 |
|---|---|---|---|
| 1 | **権限判定の一部が効かない**。読み取り系 Bash・ワークスペース内の読み取りなどは CLI が自動で許可し、`canUseTool` を呼ばない。`policy.ts` は `canUseTool` 経由でしか効かない | 公式 permissions：自動許可されたツールは `canUseTool` に届かない。Web：cwd 内の Write/Edit でも呼ばれないという報告（#493） | `hooks.PreToolUse` で `decideToolPermission` を呼び、deny を返す（hook の deny はどのモードでも効くと公式に明記） |
| 2 | **検索のたびに承認を求めそう**。0.3.162 以降、native build では Grep/Glob が無く検索は Bash 経由 | SDK の changelog | `tools` か `allowedTools` で Grep/Glob を明示する。実機で確認 |
| 3 | **コストを `reported` と表示している**が、SDK のコストは同梱の価格表による見積もり。gateway の別名モデルでは `costBasis: 'unknown'` になりうる | 公式 cost-tracking | `estimated` にする。正確な額は LiteLLM の spend から取る |
| 4 | **resume 時のコスト基準値が壊れうる**。異常終了時の result は 0 になりうる。強制 `close()` だと累計が保存されない | 公式 cost-tracking | 全額 0 のエラー結果では基準値を更新しない。強制 close 時は基準値を保存しない |
| 5 | **AskUserQuestion が承認 UI に出る**（未知のツール扱い）。承認しても回答が入らない | 公式 user-input | `disallowedTools` に入れるか、deny して自律判断を促す |
| 6 | **iterator が終わらない・interrupt が返らない**報告（Windows の異常終了を含む） | Web（#403, #425, #444） | idle timeout を入れる。interrupt → close の順序を見直す |
| 7 | **gateway の別名モデル**は最新モデル扱いになり、thinking などのフィールドが送られ、context は 200K と仮定される | 公式 gateway protocol | 実際の LiteLLM で確認。必要なら model overrides |
| 8 | **テストの fixture が手書き**で、本物の出力を記録したものではない | ― | 実際の出力を記録して fixture にし、`satisfies SDKMessage` で型検査 |

## 問題なしと確認できたもの

- `env` は置き換え（マージではない）なので、許可リスト方式で正しい
- `permissionMode: 'default'` と `settingSources: []` の明示
- resume 時の差分計上の方式（CLI 2.1.277 以降の仕様）。基準値は SQLite（`runtime_usage_baselines`）に永続化済み。Web 調査では「メモリだけで再起動すると消える」としていたが、それはテスト用の既定実装を見たもので、デーモンは DB 版を使っている
- in-process MCP のツール名（`mcp__acc__*`）と `allowedTools` への列挙

## 研究メモ（20261029_claude-agent-sdk-research.md）の古くなった点

- `permissionMode` 省略時は、CLI 2.1.302 以降は `default`（`auto` ではない）
- 「custom base URL では MCP の tool search が無効」は現行の公式と逆（gateway に転送を求めている）

snapshot は書き換えない方針なので、ここに記録しておく。
