# 2026-10-31 検証：本物の LiteLLM でプロンプトキャッシュの印と末尾の system を確かめた

`20261031_litellm-prompt-caching-research.md`（ソースを読んだ調査）の「確かめること」を、本物の LiteLLM ＋ 偽の上流で確かめた。費用なし、外向きの通信は 0 件。

## 版と入れ方（サプライチェーン対策）

- **版**：1.103.4（2026-10-07、1.104 より前の比較用）と 1.105.1（2026-10-14）。どちらも公開から 2 週間以上たったもの。PyPI の最新は 1.106.6（10-28）だが、新しすぎるので使わなかった。
- **LiteLLM 本体**：
  - PyPI の wheel には provenance（PEP 740 の証明）がない。そこで、PyPI の JSON にある SHA-256 で wheel を確かめた。
  - そのうえで、wheel の全ファイルを GitHub のタグのソース（codeload の tarball）と 1 つずつ比べた。
  - **`.py` はすべて一致**。違うのは、ビルドされた管理画面（`proxy/_experimental/out`）と、git にない Rust のネイティブ部品 `rust_bridge/_native.pyd` だけだった。
  - `.pyd` は消して使わなかった。読み込めなければ Python の実装に戻る（`loader.py` が ImportError を握る）。Rust が必須なのは OCR と Bedrock の文字起こしだけ。
- **依存（116〜118 個）**：
  - pip の dry-run で解決し、2026-10-17 より後に上がった版はすべて除いた。新しすぎたのは 26 個（pydantic 2.14.2、fastapi 0.162.0、boto3 など）。
  - 残った版を `--require-hashes --no-deps --only-binary :all:` で入れた。wheel だけなので、インストール時のスクリプトは走っていない。
- **環境**：
  - pip と python は、すべて空に近い環境変数で動かした（API キーなし、ユーザーの pip 設定なし）。
  - 入れた後、起動時に実行される `.pth` を調べた。あったのは `pywin32.pth` だけで、中身は標準の DLL の検索パスの追加だった。
  - 動かすときは既存の仕組み（`runtime/claude/contract/litellmProxy.ts`）を使った。環境変数は許可リストだけで、外向きは拒否プロキシに向けている。
- 使った venv・スクリプト・ロックファイルは作業用の一時フォルダにあり、リポジトリには入れていない。

## 準備で分かったこと：tiktoken のファイルは同梱されているが、Windows の wheel では壊れている

- `litellm_core_utils/tokenizers/9b5ad71b…`（`cl100k_base`）は wheel に入っている。ただし win_amd64 の wheel では**改行が CRLF** になっていて、tiktoken の期待する SHA-256 と合わない。
- そのため tiktoken はファイルを消し、ダウンロードを試みる。オフラインでは起動に失敗する（拒否プロキシに 1 件記録された）。
- 改行を LF に戻すと、期待どおりの `223921b7…` になった。
- 10/29 の「1.106 の wheel に入っていない」も、おそらくこれ（消された後を見ていた）。対処はこれまでと同じで、正しいファイルを `ACC_LITELLM_TIKTOKEN_CACHE` で渡す。

## 結果

### 1. 末尾の system メッセージ

| | 1.103.4 | 1.105.1 |
|---|---|---|
| Sonnet 5.5 / Sonnet 5 / Opus 5.5 | **先頭の top-level `system` にまとめられる** | 末尾に `role: system` のまま残る |
| Sonnet 4.5 | 同上 | 最後の user の発言の後ろに、`Operator note (not from the user): …` の文と本文が text ブロックとして足される |

- **1.104 より前では、実行ごとに変わる状況が先頭に入り、履歴のキャッシュは毎回壊れる**。
- 1.104 以降は、どちらの形でもそれより前は変わらない。
- 版はレスポンスの `x-litellm-version` ヘッダで分かる。裏のモデルは `x-litellm-model-name`（例：`anthropic/claude-sonnet-5-5`）で分かる。

### 2. 印の付く場所（両方の版で同じ）

| 送り方 | 上流（Anthropic）に届いた形 |
|---|---|
| system / user / tool のメッセージ自体に `cache_control` | 変換後のブロック（text / tool_result）に付く |
| content を部品で送り、部品に `cache_control` | その部品に付く |
| ツール定義の top-level に `cache_control` | ツールの `cache_control` に付く。`function` の中に置いても top-level に移る |
| `tool_calls[i].cache_control` | `tool_use` ブロックに付く |
| tool_calls つき assistant のメッセージ自体に印を付け、content を `''` にする | LiteLLM が **`[System: Empty message content sanitised to satisfy protocol]` という text を足し**、印はそこに付く |
| 同上で、content を `null` にする | 足さない。**印は消える** |
| 印を 5 つ | **5 つとも素通し**（LiteLLM は削らない。本物の API は 400 を返す） |
| `ttl: "1h"` | そのまま届く |

- tools を送らずに、履歴にツール呼び出しがあるとき、LiteLLM は `dummy_tool` を足す。

### 3. Sonnet 5 と途中の system

- 1.105.1 は、Sonnet 5 にも `role: system` のまま送る。価格表で `supports_mid_conversation_system: true` になっている（Sonnet 5 / Sonnet 5.5 / Opus 5.5 / Fable 5.1）。
- 偽の上流は受け付けるので、**本物の Anthropic が Sonnet 5 で受け付けるかは未確認**。Anthropic の docs は「非対応」としている。
- これは印とは関係なく、いま末尾に system を置いている時点で起きうる。

### 4. 使用量と費用

- `prompt_tokens` は 7100（入力 100 ＋ 読み 5000 ＋ 書き 2000）。
- 内訳は `prompt_tokens_details.cached_tokens`（読み）、`cache_creation_tokens` と `cache_write_tokens`（書き）、top-level の `cache_read_input_tokens` / `cache_creation_input_tokens`。
- **`usage.cost` は、両方の版で設定なしにストリームの最後の usage に入った**。値は価格表どおり（Sonnet 5 は 0.0063、Sonnet 4.5 は 0.00945、Opus 5.5 は 0.0116。キャッシュの単価も込み）。
- 調査で気にした `include_cost_in_streaming_usage` は、proxy が別に費用を差し込む経路のスイッチだった。この費用の有無とは関係ない（調査の読み違い）。
- その版の価格表にないモデルでは、`usage.cost` が入らない（1.103.4 の Sonnet 5.5 / Opus 5.5）。そのときは、うちの見積もり（キャッシュを区別しないバグがある）が使われる。

### 5. Claude 以外のモデル

- `openai/gpt-5.6` と `openai/gpt-5.5` で、`api_base` が偽の OpenAI 互換サーバーの場合を試した。
- メッセージとツールの `cache_control` は、**両方の版で、そのまま上流に送られた**。
- GPT-5.6 での書き換え（調査の表）は、本家の host でないと起きないので、ここでは見られない。
- やはり印は Claude にだけ送る。

## 実装への含み

- 印の位置：
  - ツールは最後の定義の top-level。
  - 先頭の system。
  - 履歴の終わりの、最後の system より前の発言。tool なら tool メッセージ自体、tool_calls つき assistant なら `tool_calls` の最後の要素。
  - 合わせて **4 つまでを、うちで守る**。
- Claude かどうか：モデル名の別名（例：`team-sonnet`）からは分からない。
  - 前回の呼び出しの `x-litellm-model-name` を覚える。
  - または LiteLLM の `/model/info` で引く。
  - 分からないうちは、印を付けない。
- 1.104 より前の LiteLLM では、末尾の system のせいで、履歴のキャッシュは効かない。`x-litellm-version` で検知して、知らせることはできる。
- tool_calls つき assistant の content を `''` で送ると、LiteLLM が文を足す（今の `openai.ts` は `m.content` をそのまま送る）。`null` にするか、今のままにするかは別に決める。
- 費用の見積もりは、キャッシュの読み書きの単価で計算し直す。

## 本物の Anthropic でないと分からないこと

- Sonnet 5 が途中の `role: system` を受け付けるか（上の 3）。
- 本物で、読みと書きのトークン数が想定どおり出るか。最小の長さ（512 / 1024）を下回るときの扱い。
