# 2026-10-29 進捗：基盤と並列モジュール

## 終わったこと

1. **基盤**（1 エージェント）：pnpm モノレポ、`@acc/protocol`（ドメイン・イベント・Control API 契約を zod で一元定義）、`@acc/client`（型付き WS クライアント、再接続と取りこぼし補完）、Core Daemon のコア（`node:sqlite`、Event Bus、ディスパッチャ、Grant 判定のフック、WS/HTTP サーバ、起動時リカバリ）、`acc` CLI。
2. **調査**（並行）：Claude Agent SDK 0.3.x（`docs/snapshot/20261029_claude-agent-sdk-research.md`）、Tauri 2 シェル（`20261029_tauri-shell-research.md`、実ビルドまで確認）、UI デザイン言語（`docs/persistent/ui-design.md`）。
3. **モジュール間の契約を先に固定**：`packages/daemon/src/contracts.ts`（runs / budget / workspaces / runtimes）。並列実装の前に縫い目を決めておくことで、別 worktree で作ったモジュールが噛み合うようにした。
4. **並列モジュール実装**（5 エージェント、各自 worktree + ブランチ）：
   - runs-chat：Run ライフサイクル・同時実行キュー・承認・LLM Gateway（LiteLLM / mock）・チャット Run・ツールループ・全文検索
   - workspace-integration：git worktree・ロック・diff・Artifact・Integration（順次マージ→テスト→人間だけが承認して反映）
   - policy-tasks：Capability Grant（委譲の部分集合・深さ・失効・連鎖剥奪）・Budget（不変条件をトランザクションで強制）・Task DAG
   - runtimes：Agent Runtime 抽象、Claude Agent SDK 実装、実際にファイルを書く mock 実装、agent Executor
   - desktop-ui：Tauri + React の UI 一式（司令室 / フォーカス / タイムライン / パレット / オンボーディング）
5. 5 ブランチを `vertical-slice` にマージ。衝突は docs・テスト・lockfile のみで、契約ファイルのおかげでコードの衝突はなかった。

## マージ後に見つかったもの

- 型付き ESLint がリポジトリ全体でメモリ不足
- Task スキーマへのフィールド追加で、他 track のテスト用フィクスチャが型エラー
- 別々に作ったモジュールが本物同士でつながったことで落ちたテスト 2 件

→ 次のワークフローで安定化してから、Orchestrator の結線（Vertical Slice 本体）と UI の実 API 結線を並列で進める。

## 判断メモ

- UI は未実装メソッドに対して「空表示で壊れない」方針で先行させた。並列開発中でも画面の手触りを詰められるようにするため。
- エージェントの承認判定（読み取り・worktree 内の編集は許可、コマンドと外部パスは承認）はプロンプトではなく純関数で決める（concept §11）。
- `integration.approve` は Grant があっても人間以外は拒否（concept §6.3、§13「完全自律での本番変更」をしない）。
