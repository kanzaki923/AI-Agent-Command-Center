# GitHub Copilot をプロバイダにできるか（調査）

2026-11-05 時点。会社で契約している Copilot（Business / Enterprise）を、このアプリから使えるようにしたい。

## 結論

- **公式の道は Copilot SDK（`@github/copilot-sdk`、2026-06 GA、調査時 1.0.28）**。組み込みツールを全部切って、ツールの実行をこちらに戻せば、ほぼ「プロバイダ」として使える。
- Copilot の API を直接呼ぶ道（LiteLLM の `github_copilot`）は非公式。他社エディタの OAuth クライアント ID を借りる形で、GitHub は第三者の利用を認めていない。**会社のアカウントでは使わない**。
- ChatGPT は第三者向けの公式 "Sign in with ChatGPT" がある。Copilot には、素のモデル呼び出しを第三者のアプリに開く公式の仕組みがない。公式の入り口は SDK だけ。

## Copilot SDK で確かめたこと（パッケージの型定義から）

- **ツール**：`SessionConfig.availableTools` / `excludedTools` は `builtin:*` / `mcp:*` / `custom:*` の絞り込みが書ける。`excludedTools` が優先される。`excludedTools: ['builtin:*']` で、Copilot CLI のファイル操作や Git を切れる。
- **ツールの実行**：`tools` に `handler` を持たないツールを渡すと「宣言だけ」になり、呼び出しは保留中のツール呼び出しの RPC でこちらに返る。権限のチェックは Core Daemon に残せる。
- **使用量**：`assistant.usage` イベントに次が入る。
  - `inputTokens` / `outputTokens` / `cacheReadTokens` / `cacheWriteTokens` / `reasoningTokens`
  - `copilotUsage.totalNanoAiu`（リクエストの費用、nano-AI units）
  - `aiCreditsStatus`
  - ほかに `session.usage_info` があり、残りの枠・リセット日・SKU（`copilot_for_business_seat_quota` など）が取れる。
- **認証**：`useLoggedInUser`（`copilot login` 済みの CLI の資格情報。既定）か `gitHubToken`（`gho_` / `ghu_` / fine-grained PAT。classic PAT は不可）。`gitHubToken` を渡すと `useLoggedInUser` は既定で false。
- **課金先**：利用は各ユーザーの Copilot 契約に付く（公式ドキュメント「GitHub OAuth」）。
- **モデル一覧**：`client.listModels()`。
- Node / Python / .NET は Copilot CLI を同梱している。SDK は CLI のプロセスと話す。

## 料金（2026-06-01〜）

premium requests をやめて **GitHub AI Credits の従量制**になった。各モデルの API 単価でトークン分を消費する。プランには毎月の枠が付き、超えたあとは組織の設定しだいで止まるか追加課金。ChatGPT のように「契約枠で 0」とは表示できない。

## 未確認

- `totalNanoAiu` からドルへの換算（1 AI Credit = $0.01 という記事はあるが、AIU との関係は未確認）。
- システムプロンプトを丸ごと差し替えられるか（`systemMessage` の詳細）。Copilot 側の既定のプロンプトが混ざらないか。
- 毎回新しいセッションに履歴をまとめて渡したとき、プロンプトキャッシュが効くか。
- 組織のポリシーで Copilot CLI を止めていると SDK も使えないか（たぶん使えない）。

## 実装するときの論点

- 今の `ctx.service('llm')` は「毎回、履歴を全部渡す」作り。SDK は「セッションが履歴を持つ」作り。どちらかで合わせる。
  - **会話ごとにセッションを持つ**：効率はいいが、@ での呼び出しや要約で履歴を書き換えたときの整合が面倒。
  - **毎回新しいセッションに履歴を入れる**：作りは素直。キャッシュとシステムプロンプトの確認が要る。
- 接頭辞は `copilot/*` にして、設定のプロバイダの行に `GitHub Copilot`（ChatGPT と同じサインインの見た目）を並べる。
- 後で、同じ SDK を Claude Agent SDK と並ぶ実行基盤（コーディングエージェント）にもできる。こちらが SDK の本来の使い方。

## 次にやること

会社のアカウントで `copilot login` して、使い捨てのスクリプトで次を確かめる。

1. ツールを全部切って、ただの会話ができるか。
2. `assistant.usage` に実際の値が入るか。
3. システムプロンプトを差し替えられるか。

あわせて、組織のポリシー（Copilot CLI の許可、AI Credits の追加課金）を確認する。

## 出典

- https://docs.github.com/en/copilot/how-tos/copilot-sdk/set-up-copilot-sdk/github-oauth
- https://docs.github.com/en/copilot/how-tos/copilot-sdk/auth/authenticate
- https://github.com/github/copilot-sdk
- https://github.blog/changelog/2026-06-02-copilot-sdk-is-now-generally-available/
- https://github.blog/2026-05-01-github-copilot-is-moving-to-usage-based-billing/
- https://docs.litellm.ai/docs/providers/github_copilot
