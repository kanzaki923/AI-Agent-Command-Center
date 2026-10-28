# 2026-10-29 進捗：Vertical Slice 成立

## 結果

concept.md §12.1 の 9 ステップが、実デーモン + 実 UI（ブラウザ）でオフライン（mock モデル / mock ランタイム）のまま通しで動いた。

- デーモン側の受け入れテスト：`packages/daemon/src/e2e/vertical-slice.test.ts`
- UI 側の通し：`pnpm --filter @acc/desktop e2e:slice`（オンボーディング → デモ → Orchestrator 権限付きチャットで目標を送信 → Task 2 件に分解 → Worker 2 人が別 worktree で並列作業 → 承認（Ctrl+J → Y）→ 統合（マージ + `node --test`）→ 人間が「承認して反映」→ main が実際に早送りされたことを git で確認）。マージ後のコードで約 18 秒で PASS。
- テスト 413 件、lint / typecheck 通過。

## この段階の判断

- **Orchestrator は役割**：`session.grantOrchestration` で普通のチャットに Grant を付けると、そのチャットの Run が `orchestrator` になる（concept §3.1）。ツールは Control API 定義から生成し、Grant で絞る。
- **`integration.approve` は人間だけ**：Orchestrator の Grant にも含めず、仮に含めてもディスパッチャが拒否する。
- **`task.wait` / `integration.wait`**：Orchestrator の流れを「Task 作成 → Worker 起動 → 全完了を待つ → 統合 → 統合完了を待つ → 報告」の一直線にし、LLM にとって単純にした。
- **デモの最初のメッセージは自動送信しない**：提案チップにして、人間が 1 クリックで送る。
- **イベント配信順の修正**：トランザクション内で開始した Run のイベントが後続より先に届く問題を、コミット後フックの直列化で解消（UI がイベントを捨てていた）。

## 残課題（次のワークフローで着手）

- 統合のコンフリクトを Integrator エージェントに直させる流れ、テスト失敗時の差し戻し
- デーモン再起動後の Orchestrator 再開
- 予算の事前予約（いまは事後記録なので最後の 1 回が上限を超えうる）
- Tauri の実 exe 起動と、デーモン同梱
- 未着手 Task の一覧、リポジトリの事前検証、OS 通知、細部の手触り
- 本物の経路（LiteLLM + Claude Agent SDK）での通しは未実施（課金が発生するため、ユーザーの判断で実施する）
