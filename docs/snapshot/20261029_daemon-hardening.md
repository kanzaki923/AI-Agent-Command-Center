# 2026-10-29 デーモンの堅牢化（track/daemon-hardening）

`20261029_vertical-slice.md` の「既知の制約・残り」のうち、デーモン側の 5 件を埋めた。仕様の要点は `docs/persistent/architecture.md` §2.5・§2.6・§2.8・§2.10・§2.12。

## 入ったもの

1. **Integrator**：`integration.resolveWithAgent`。コンフリクトを統合用 worktree に再現し、`agent` Run（Task なし）に両側の目標を渡して解消させ、マージコミットを確かめてから統合を「再開モード」で続ける（作り直さない）。mock ランタイムは未解決ファイルがあれば ours + theirs で解消する（`resolve` ステップも追加）。`mock/orchestrator` はコンフリクトで 1 回だけ呼び、まだコンフリクトなら人間に相談する。
2. **差し戻し**：`task.retry`。同じ Worker セッション・worktree・ブランチで再実行し、統合のテスト失敗の出力末尾を指摘に含められる。
3. **再起動耐性**：中断された Worker の Task は `ready`（`interrupted`）になり `task.retry` で再開できる。中断された Orchestrator には system メッセージで状況を知らせ、`settings.autoResumeOrchestrators`（既定 true）と有効な Grant があれば新しい Run で続きから進める。
4. **予算の予約**：chat / orchestrator の LLM 呼び出しごとに `settings.llmCallReserveUsd`（既定 $0.25）を reserve → settle。同じ Budget を共有する Run の同時実行でも超過しない。Agent Runtime は事後の `recordSpend` と開始前の空き確認。Worker への切り出しは呼び出し元の分を 1 つ残すようにした（以前は 2 人目の Worker で Orchestrator の空きが 0 になり、次の LLM 呼び出しができなかった）。
5. **`project.inspectRepo`**：git リポジトリのルートかの検査と、名前・既定ブランチ・テストコマンドの提案。
6. **Worker の Control API ツール**：Grant の範囲のメソッドを `AgentRunInput.tools` で渡し、Claude ランタイムは in-process MCP サーバ `acc`（`mcp__acc__task_get` など）にする。

## 検証

- `pnpm check` 通過。デーモンの受け入れテスト（`e2e/vertical-slice.test.ts` に README を両方が触る変種を追加）、ブラウザ E2E（`pnpm --filter @acc/desktop e2e:slice`）とも通過。
- 再起動は `orchestrator/resume.test.ts`（`startTestDaemon({ home })` で停止 → 起動 → 再開 → 統合まで、自動再開オフ、2 回目の起動で重複しないこと）。

## 既知の制約・残り

- 予約額は固定値。`max_tokens × 単価` の見積もりは単価表がないため未実装（`runToolLoop` の `reserveUsd` で差し替えられる）。1 回の実額が予約額を超えると、その分は超過として記録される。
- Agent Runtime（Claude）は呼び出しごとの予約ができない。SDK の `stream_event` の usage で途中停止する案（SDK 調査メモ §5 の 7）は未着手。
- 再起動のテストは正常停止（`daemon_shutdown`）の経路。異常終了（`daemon_restart`）は同じ照合を通るが、プロセスを落とす E2E はない。
- `task.retry` を `mock/orchestrator` が自動で呼ぶのは再開時だけ。テスト失敗時は対応案として示すだけで、原因 Task の特定は本物のモデルか人間の仕事。
- UI は `resolveWithAgent` / `task.retry` / `inspectRepo` / 新しい設定をまだ出していない（契約とイベントは揃っている。統合の `fix` 手順は既存の手順表示で見える）。
- MCP ツールは本物の Claude Code CLI では未確認（SDK の `tool` / `createSdkMcpServer` を使った単体テストまで）。
