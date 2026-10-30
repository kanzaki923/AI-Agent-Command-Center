# 2026-10-30 引き継ぎ（夜）：プロバイダ制と ChatGPT の契約枠

`20261030_evening_handoff.md` の続き。ブランチ `vertical-slice`、`pnpm check` 緑。

## 入ったもの

- **プロバイダ制**（`20261030_providers.md`）：Anthropic 直（Messages API、プロンプトキャッシュ付き。本物で右腕 7 往復 $0.005）、OpenAI 直（Responses API）、ChatGPT の契約枠（Sign in with ChatGPT）を LiteLLM と同時に持てる。モデル名の接頭辞で振り分け。
- **ChatGPT のサインインは実機で通った**（`20261030_providers.md` の「未確認」は解消）。躓きは 1 つ：デーモンが `cmd /c start` で URL を開くと `&` で切れる → UI が開く形に（`aa14361`）。設定の行はアドレスを出さず「サインイン済み」、押したときだけ表示。
- 右腕の過去の実行は「呼び出しはそのまま、結果は要約」で覚える（文字の記録は本物の Haiku が真似した）。

## 残っていること

- Codex ランタイム（コーディングエージェントを ChatGPT の枠で）。`runtime/` に Codex を足し、権限ゲートを approval policy に写す。
- LiteLLM 経由の `/responses`、LiteLLM 経由のキャッシュ、Anthropic 直の extended thinking。
- `20261030_evening_handoff.md` の残り（名前、Sonnet 以上での右腕、透けの「全体・強」の読みやすさ）。
