# AI Agent Command Center

複数の LLM セッションとコーディングエージェントを並列に実行・監督するデスクトップアプリケーション。

## 特徴

- **並列実行**：複数のセッションを並行に実行し、各セッションの状態（実行中・入力待ち・完了）を一覧で把握できる。
- **LLM によるオーケストレーション**：監督役の LLM が依頼を分解し、子セッションの起動・待機・結果の統合を行う。
- **コーディングエージェント**：Claude Agent SDK を Git worktree 上で実行し、差分はテストと承認を経て統合する。
- **権限制御**：ツールの実行可否はプロンプトではなくデーモンのポリシーで判定する。破壊的な操作や外部への送信は拒否し、判定できない場合だけ承認を求める。
- **コスト管理**：費用をセッション・モデル単位で記録し、予算の上限を強制する。
- **常駐実行**：実行基盤は UI から独立したデーモンとして動作する。UI を閉じても、実行中のタスクと定期実行は継続する。
- **定期実行**：cron 式（タイムゾーン指定可）または日時を指定して、セッションを実行する。

## 対応する LLM

- Anthropic（Messages API）
- OpenAI（Responses API、ChatGPT アカウントでのサインイン）
- LiteLLM Proxy 経由のモデル
- モックモデル（API キーなしでの動作確認用）

## 必要環境

- Node.js 22.12 以上
- pnpm 10
- Rust と Tauri 2 の前提環境（[Prerequisites](https://tauri.app/start/prerequisites/)）
- Claude Code（コーディングエージェントを使う場合）

## セットアップ

```sh
pnpm install
pnpm dev:desktop   # デーモンと UI を開発モードで起動
```

LLM の接続先は「設定 → 接続」で指定する。未設定でも、モックモデルで動作を確認できる。

CLI からも同じ操作ができる。

```sh
pnpm acc status      # デーモンの状態
pnpm acc sessions    # セッションの一覧
pnpm acc events -f   # イベントの追従表示
```

その他のコマンドは [docs/persistent/development.md](docs/persistent/development.md) を参照。

## 構成

```
apps/desktop       Tauri 2 + React の UI（デーモンのクライアント）
packages/daemon    Core Daemon（Node.js の常駐プロセス、SQLite）
packages/protocol  ドメイン型と Control API の定義（zod）
packages/client    型付きの API クライアント
packages/cli       CLI（acc）
```

UI・CLI・LLM は、いずれも WebSocket 経由で同じ Control API を呼び出す。LLM 向けのツール定義は API の定義から生成する。詳細は [docs/persistent/architecture.md](docs/persistent/architecture.md) を参照。
