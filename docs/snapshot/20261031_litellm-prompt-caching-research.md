# 2026-10-31 調査：LiteLLM 経由のプロンプトキャッシュ

LiteLLM 経由の呼び出し（`llm/openai.ts`、`/chat/completions`）には `cache_control` を付けていない。そのため、LiteLLM 側で注入していなければ、Claude のキャッシュは効いていない可能性が高い。直す前に仕様を調べた。

- 読んだもの：LiteLLM の main（commit `84617874`、2026-10-30、pyproject は 1.109.0）。比較に `v1.103.10` も読んだ。Anthropic の prompt caching の docs も参照した。
- 本物の LiteLLM ではまだ確かめていない。下の「確かめること」は、実物で見るまで仮説のまま。

## 1. 一番大事：末尾の system メッセージ

うちの会話は、実行ごとに変わる状況を**最後の system メッセージ**として履歴の後ろに置いている（`20261031_conversation-framing-spec.md` のキャッシュの節）。

**LiteLLM 1.104.0 未満**
- 位置に関係なく、すべての `role: system` を Anthropic の top-level `system` に移す（v1.103.10 の `anthropic/chat/transformation.py`）。
- その結果、system が実行ごとに変わり、**履歴のキャッシュが毎回壊れる**。クライアント側の工夫では直せない。

**LiteLLM 1.104.0 以降**（PR #42630、2026-09-25）
- top-level `system` に移すのは、先頭に連続する system だけ（`split_leading_system_run`。main の transformation.py 2340 行付近で確認）。
- 後ろの system はその位置に残る。モデルが「会話の途中の system」に対応していれば `role: system` のまま、対応していなければ「Operator note」の文を付けた user の発言になる。
- どちらでも、それより前の部分は変わらない。
- Bedrock（Converse）は、後ろの system を常に user の発言にする。

## 2. 印の付け方（LiteLLM が受け付ける形）

- **system / user / tool**：文字列の content のままなら、メッセージ自体に `cache_control` を付ければ、変換後のブロックに付く。
- **assistant**：
  - tool_calls があるときは `tool_calls[i].cache_control` に付ける（`tool_use` ブロックに付く）。
  - 本文が空で tool_calls だけの assistant に、メッセージ自体の印を付けると消える。
- **ツール定義**：tool の top-level（`{type, function, cache_control}`）に付ける。Anthropic 経路は `function` の中も読むが、Bedrock Converse は top-level しか読まない。
- **`ttl: "1h"`**：通る。Bedrock では、価格表に 1h の単価があるモデルだけ残る。
- **印の数**：4 つまでは、クライアントが守る必要がある。LiteLLM は 5 個以上を削らない。
- **LiteLLM 側の注入**（`cache_control_injection_points`）：クライアントが印を付けたメッセージは飛ばし、合計 4 つを超えないように止める。なので、両方使っても重ならない。
- **top-level の自動キャッシュ**（`cache_control`）：Anthropic 直結と Vertex では通る。Bedrock と、裏のプロバイダが分からないときは使わない。

## 3. Claude 以外のモデルに印を送ったとき

LiteLLM のモデル名の裏が何かは、うちからは分からない。

| 裏のプロバイダ | 印を送るとどうなるか |
|---|---|
| OpenAI（GPT-5.6 より前） | 印は削られる。害はない |
| OpenAI GPT-5.6 以降 | `prompt_cache_breakpoint`（明示的なキャッシュ）に書き換えられ、課金が変わる |
| Gemini | 印の付いた部分が `cachedContents` に移され、ストレージの課金が起きる。暗黙のキャッシュも効かなくなる |
| `api_base` を指定した OpenAI 互換（vLLM など） | 印が残ったまま送られる。相手が知らないキーを嫌うとエラーになりうる（未確認） |

→ **印は Claude のモデルにだけ送る**のが安全。

## 4. 使用量と費用

**Anthropic の使用量**
- `prompt_tokens` は、キャッシュの読み・書きを**含む**。
- `prompt_tokens_details.cached_tokens` が読み。書きは `cache_creation_tokens`。
- usage の top-level にも `cache_read_input_tokens` / `cache_creation_input_tokens` が出る。うちの `openai.ts` はどちらも読めている。

**ストリームでの費用（`usage.cost`）**
- main のソースでは、proxy の `litellm.include_cost_in_streaming_usage: true` がないと入らない（既定は false）。
- ところが 10/29 の契約テスト（LiteLLM 1.106.6）では、この設定なしで `usage.cost` が届いていた。
- **食い違っているので、実物で確かめる。**

**うちの見積もりのバグ**
- LiteLLM が費用を返さなかったとき、`openai.ts` の見積もりは、`prompt_tokens` 全体を入力の単価で計算している。
- キャッシュの読み（0.1 倍）も書き（1.25 倍・2 倍）も区別していないので、**キャッシュが効くほど費用を高く見積もる**。直す対象。

## 5. Anthropic 側の決まり

- 印は 4 つまで。
- 最小の長さは、Opus 5.5 / Sonnet 5.5 / Haiku 5.5 / Fable 5 系が 512 トークン、Sonnet 5 / Sonnet 4.x が 1024。足りなくてもエラーにはならず、ただキャッシュされない。
- 印から 20 ブロックまでさかのぼって、前回の書き込みを探す。
- 1 時間の印は、5 分の印より前に置く。

## 6. 確かめること（本物の LiteLLM ＋ 偽の Anthropic、費用なし）

既存の `llm/litellm-contract.test.ts` の仕組み（偽 API が受け取った本文を残す）でそのまま確かめられる。

1. 末尾の system がどう送られるか。1.104 未満と以上で比べる。
2. 印が付く場所：最後のツール、先頭の system、履歴の終わり（user / tool / tool_calls つき assistant のそれぞれ）、最後のブロック。4 つ以内か。
3. Sonnet 5 で末尾の system が `role: system` のまま送られるか。価格表は「途中の system に対応」としているが、Anthropic の docs は「Sonnet 5 は非対応」としていて、食い違っている。送られるなら本物では 400 になりうる。
4. 偽 API の返す usage（キャッシュの読み・書き）が、ストリームの最後の usage にどう出るか。`usage.cost` が出るか。
5. Claude 以外のモデル名で、印を送らない分岐が効くか。
