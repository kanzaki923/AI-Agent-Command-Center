# 2026-10-29 本物の Anthropic API を LiteLLM 経由で最小限確かめた

`20261029_litellm-contract.md`（偽の上流での確認）の続き。ユーザーの許可を得て、別プロジェクトの API キーを**この確認のためだけに**使った。キーは LiteLLM の設定に変数名（`os.environ/...`）で書き、LiteLLM のプロセスにだけ渡した。値は表示・保存していない。

## 条件

- 経路：デーモン / CLI → 計数用プロキシ（1 件ずつ、3 秒以上空ける、上限 10 件、401/403/429/過負荷/5xx で打ち切り）→ LiteLLM 1.106.6（127.0.0.1、`num_retries: 0`）→ `api.anthropic.com`
- モデル：Haiku 5.5（作業）、Sonnet 4.6（auto mode の分類器）。出力は 256 トークンまで
- CLI：Agent SDK 0.3.312 同梱の 2.1.312

## 結果：上流へ 9 件、すべて 200、費用は約 $0.13

| 確認 | 結果 | 費用 |
|---|---|---|
| Gateway（`/chat/completions`）でツール 1 回 → 回答 | ○ 2 件。`usage.cost` を `costSource: reported` で計上（$0.000173） | ほぼ 0 |
| CLI で Read 1 回（`permissionMode: default`） | ○ 2 件。`tool_result_meta` は `reason_type: mode` | $0.0023（SDK の見積もり） |
| CLI の auto mode（`CLAUDE_CODE_AUTO_MODE_SERVER=0`） | ○ 作業 2 件＋分類器 1 件（Sonnet 4.6、非ストリーム）。`reason_type: classifier` で許可 | 分類器 $0.126、作業 $0.0012 |
| CLI の auto mode（サーバー側判定。`CLAUDE_CODE_AUTO_MODE_SERVER` を外す） | ○ 作業 2 件のみ。リクエストに `safeguards` が付き、**分類器の別リクエストは出なかった**。判定は `reason_type: classifier` で許可 | $0.0012 |

## わかったこと

1. **LiteLLM を挟んでも、本物の API で両方の経路が動く。** Control API のツールスキーマ、CLI が送る `thinking` / `context_management` / `output_config` / beta ヘッダ、別名ではない現行モデル名のどれも、上流で拒否されなかった。
2. **auto mode の分類器が費用の大半を占める。** 初回は分類器のプロンプト（約 3.3 万トークン）をキャッシュに書き込むため、Sonnet 4.6 で 1 回 $0.126。作業本体（Haiku）の 100 倍。2 回目以降はキャッシュの読み取りになり安くなるはずだが、今回は測っていない。この額は SDK の `total_cost_usd` には入らない（既知。Budget は少なく数える）。
3. **サーバー側の判定（`safeguards`）は LiteLLM を素通しで動いた。** 上流が本物の Anthropic なら、分類器の別リクエストとその費用がなくなる。いまのランタイムは `CLAUDE_CODE_AUTO_MODE_SERVER=0` で固定しているので、上流が Anthropic API のときはサーバー側判定を使うのが次の改善候補（Bedrock / Vertex を上流にした LiteLLM で通るかは未確認なので、設定で切り替える）。応答のどのフィールドに判定が入るかは、今回の記録では取れていない。
4. CLI の費用は SDK の価格表での見積もり（`costBasis: list`）。LiteLLM の `x-litellm-response-cost` ヘッダが付いたのは、非ストリームの分類器のリクエストだけだった。

## まだ確かめていないこと

- thinking の署名つきブロックの往復（Haiku で thinking が出なかった）
- 分類器が拒否する場面の本物での挙動、2 回目以降の分類器の費用
- 429 / 過負荷のときの再試行の掛け算（費用と BAN の危険があるので本物ではやらない）
- DB ありの LiteLLM（仮想キー、予算、spend ログ）
