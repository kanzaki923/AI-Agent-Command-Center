# 2026-10-30 プロバイダ制：LiteLLM だけでなく Anthropic 直・OpenAI 直・ChatGPT の契約枠

会社は LiteLLM 一択、家では Anthropic や OpenAI を直接叩く。その両方で使えるように、チャット Run の接続先を「LiteLLM の URL」から「プロバイダの集まり」にした。コーディングエージェント（Claude Code CLI）は前から LiteLLM なしなら手元のログインで直接行っていたので、変わったのはチャット Run（右腕・監督役・普通の会話）の側。

## 形

- **同時に複数**。モデル名の接頭辞で Gateway が振り分ける：`anthropic/claude-…` → Messages API、`openai/gpt-…` → Responses API、無印 → LiteLLM（これまでどおり）、`mock/…` → モック。監督役が子ごとに別のプロバイダのモデルを選ぶ布石。
- **Anthropic ネイティブ**（`llm/anthropic.ts`）：`/v1/messages` の SSE。system の先頭ブロックと最後の tool に `cache_control: ephemeral`（固定の役割＋ tools が 1/10 の価格で読める）。usage の cache_read / cache_creation を単価に乗せる（`estimated`）。thinking ブロックは署名ごと往復。
- **OpenAI Responses**（`llm/openaiResponses.ts`）：chat/completions ではなく `/v1/responses`。system は `instructions`、会話は `input` の item（`function_call` / `function_call_output`、推論 item は `encrypted_content` ごと往復）、`store: false`・`stream: true`。認証は 2 通り：API キー（課金。単価表で `estimated`）と **ChatGPT の契約枠**（サインイン済みならこちらを優先。費用 0 の `reported`。`temperature` / `max_output_tokens` は送らない）。
- **Sign in with ChatGPT**（`llm/chatgptAuth.ts`、developers.openai.com/siwc の OSS 向け）：`auth.openai.com/api/accounts/authorize` に PKCE で、初回は `client_id=dynamic_agent_client` ＋ `agent_name_hint` ＋ この機械の `ext_agent_host_id`（`urn:uuid`、config.json に保存）。loopback は `http://127.0.0.1:<port>/auth/callback`（host と path は固定、port だけ可変）。戻りの `client_id` を保存して以後はそれで。トークン交換と refresh（30 日で回転）は `api/accounts/oauth/token`、ID トークンは iss / aud / nonce / exp と JWKS の署名を検証、`chatgpt.tokens.use.direct` の scope がなければ失敗。サインアウトは `revocation_endpoint`。再サインインが要るエラー（`invalid_grant` など）は資格情報を消して理由を出す。
- **設定**：`settings.providers.anthropic / openai`（apiKey・baseUrl）、`providers.openai.chatgpt`（秘密。クライアントには `{ email }` だけ）。`settings.update` でキー、`chatgpt.signIn / status / signOut` でサインイン（人間だけ）。「接続あり」の判定は LiteLLM・各キー・ChatGPT のどれか（`isLlmConfigured`）。
- **Claude Code CLI**：LiteLLM がなく Anthropic のキーがあれば `ANTHROPIC_API_KEY` で直接（`runtime/env.ts` の `anthropic-key`）。なければ従来どおりログイン。
- **単価**：OpenAI の表を足した（gpt-5 系・4.1 系・4o・o3 / o4-mini、2026-10 時点）。知らない名前は最高単価に倒す。
- **UI**：設定の「接続」の `変更` で LiteLLM / Anthropic / OpenAI / ChatGPT の 4 行。キーは入力して保存、戻りはマスク。ChatGPT は `ChatGPT でサインイン` → ブラウザ → 「ブラウザで続けてください」→ アカウントのメールと `サインアウト`。接続の要約行は `127.0.0.1:4000 · 9 モデル · Anthropic · ChatGPT me@…` のように並ぶ。

## 確かめ方

```sh
# チャット Run を本物で（右腕の 7 往復）
ACC_ANTHROPIC_API_KEY=<キー> node --import tsx packages/daemon/scripts/real-right-hand.ts anthropic/claude-haiku-5-5 <出力>
ACC_OPENAI_API_KEY=<キー>    node --import tsx packages/daemon/scripts/real-right-hand.ts openai/gpt-5-mini <出力>
```

ChatGPT の契約枠はブラウザでのサインインが要るので、アプリの設定から試す（`pnpm dev:desktop` → 設定 → 接続 → 変更 → ChatGPT でサインイン）。モデル一覧はサインインした契約で使えるもの（`/v1/models` の `visibility: list`）。

## 決めたこと・注意

- LiteLLM は chat/completions のまま（会社の環境で実測済み。LiteLLM の `/responses` への切り替えは手応えを見てから）。
- OpenAI でキーとサインインの両方があるときは**サインイン（契約枠）を優先**。枠を使い切ると `llm_quota_exceeded`（再試行しない。ChatGPT の設定 → 利用状況へ）。
- Anthropic の `cache_control` は常に付ける（小さすぎれば API が無視する）。LiteLLM 経由のキャッシュは別の話（未対応）。
- OSS のローカルアプリは SIWC の対象。有料配布やリモートホストは OpenAI の申請が要る。
- 偽の認可サーバーで一連の流れをテストしている（`llm/providers.test.ts`）。本物の auth.openai.com は未確認。

## まだ

- 本物の ChatGPT サインインの実機確認（ブラウザが要るのでユーザーの手で）。
- Codex ランタイム（コーディングエージェントを ChatGPT の枠で）。`runtime/` の抽象に Codex（app-server / SDK）を足す。権限ゲートを Codex の approval policy に写すのが本体。
- LiteLLM 経由の `/responses`、LiteLLM 経由のキャッシュ。
- Anthropic ネイティブでの extended thinking の有効化（いまは送っていない）。
