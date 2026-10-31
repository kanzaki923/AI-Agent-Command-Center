# 本物の Anthropic でプロンプトキャッシュを確認（2026-10-31）

`20261031_litellm-prompt-caching-verified.md` で「本物でないと分からない」とした 2 点を、本物の Anthropic API で確かめた。費用は 3 回の計測の合計で約 $0.32。

## やり方

- 一時的なテスト（コミットしない）で、daemon の `AnthropicProvider`（直接）と `OpenAiCompatibleProvider`（本物の LiteLLM 1.105.1 経由、上流は本物の Anthropic）を呼んだ。キーは環境変数名で LiteLLM に渡し、値は表示も記録もしていない。
- 1 モデルにつき、daemon の実際の流れをなぞった 3〜4 回：
  - **A**：`[system(約4k), user1, system(実行ごとの状況)]`、ツール 1 つ。
  - **B**：A ＋ assistant(ツール呼び出し) ＋ tool の結果（同じ実行の 2 回目）。
  - **C**：次の実行。`[system, user1, assistant(呼び出し), tool, assistant(答え), user2, system(新しい状況)]`。
  - **D**（LiteLLM のみ）：assistant の答えと次の user の間に system がある履歴（再開の通知を想定）。
- 1 回目は全フローで同じ system の文を使ったので、フロー間でキャッシュを読み合ってしまった。2 回目からは、フローごとに文を変えた。

## 結果（2 回目の計測。単位はトークン）

| 経路・モデル | A 書き | B 読み / 書き | C 読み / 書き | D |
|---|---:|---:|---:|---|
| 直接 Sonnet 5.5 | 4,006 | 4,006 / 62 | 3,974 / 141 | — |
| 直接 Haiku 5.5 | 4,005 | 4,005 / 62 | 3,973 / 139 | — |
| LiteLLM Sonnet 5.5 | 3,977 | 3,977 / 88 | 3,977 / 108 | 成功 |
| LiteLLM Haiku 5.5 | 3,973 | 3,973 / 88 | 3,973 / 109 | 成功 |
| LiteLLM Sonnet 5 | 4,042 | 4,042 / 87 | 4,042 / 106 | 成功 |
| LiteLLM Opus 5.5 | 下の「拒否」を参照 | | | |

- **キャッシュは設計どおりに効く**。同じ実行の 2 回目は前回の全体を読み（B）、次の実行は最初の user までを読む（C。`markForCache` の anchor）。読まれないのは、実行ごとの状況と新しい発言だけ。
- 直接接続では、実行ごとの状況が user の発言の中に入るので、A がそこまで書き、B がそこまで読む。LiteLLM 経由では状況が `role: system` のまま後ろにあり、印が付かないので書かれない（毎回 30 トークンほどが通常の入力）。どちらも誤差の範囲。
- **Sonnet 5 は途中の `role: system` を受け付けた**（LiteLLM が価格表の `supports_mid_conversation_system: true` に従ってそのまま送る）。A〜D のどれも 400 にならず、状況の文は入力に数えられている。Anthropic の docs の「非対応」とは食い違うが、2026-10-31 時点の本物は受け付ける。
- D の形（assistant の後の system）は、LiteLLM が次の user の後ろへ移すので、どのモデルでも通った。daemon で並べ替える必要はない。
- 費用：LiteLLM が返す `usage.cost` は価格表どおり（キャッシュの単価込み）。Haiku 5.5 は 1.105.1 の価格表にないので `cost` が来ず、daemon の組み込みの単価で見積もる。

## Opus 5.5 の拒否

- 計測用の system（「Rule 1…60」を並べた文）が、Opus 5.5 の安全フィルタで拒否されることがあった（2 回目・3 回目）。出力は 0 トークン。LiteLLM 経由の終了理由は `content_filter`、直接では `stop_reason: refusal`。
- **拒否された呼び出しが書いたキャッシュは、後の呼び出しで読まれなかった**。毎回全体を書き直すので、1 回 $0.02 ほどかかった。1 回目の計測では拒否されず、ほかのモデルと同じように読めた。
- daemon の扱い：
  - 直接接続では、`refusal` を `stop` に変えている（`anthropic.ts` の `finish()`）。
  - tool loop は終了理由を見ない。空の返事を保存して、Run は完了で終わる。
  - つまり、断られたことが人に伝わらない（未対応）。
