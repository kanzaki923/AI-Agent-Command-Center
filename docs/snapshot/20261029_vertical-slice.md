# 2026-10-29 Vertical Slice（concept §12.1）がデーモンで通った

## この時点で証明できたこと

受け入れテスト `packages/daemon/src/e2e/vertical-slice.test.ts`（本物の WS サーバ + `@acc/client`、一時 `ACC_HOME`、`testCommand: node --test` の一時 git リポジトリ、`mock/orchestrator` と mock ランタイム、ネットワークなし）が次を確かめる。

1. 人間がチャットを作り、`session.grantOrchestration` で Orchestrator 権限を与える（セッション種別は `chat` のまま）
2. 「認証まわりのドキュメントとテストを並列で整備して」を送ると、その Run は `orchestrator` 種別になる
3. Orchestrator が Control API ツールで Task を 2 つ作り（完了条件つき）、`task.spawnWorker` ×2
4. 2 つの Worker が別々の worktree で**同時に**動く（両方が始まるまで終われないようにしても終わる＝直列ではない。開始・終了時刻も重なる）
5. テスト担当の Worker のコマンド実行が承認待ちになり（`risk: medium`）、テストが `approval.respond` で承認する
6. その間、Worker（深さ 1）は `task.spawnWorker` も `grant.create` も `forbidden`
7. 両 Task が diff Artifact つきで `review` に → Orchestrator が `integration.create` → `run` → `wait`、両ブランチをマージしてテスト成功、`awaiting_approval`
8. Orchestrator が「2件のTaskが完了し、統合候補ができました。テスト: 成功。レビューして承認してください」と ID つきで報告
9. agent からの `integration.approve` は `forbidden`、人間が承認すると `main` に両方の変更が入る
10. イベント列が最初から最後まで順に物語になっている（`policy.denied` は拒否した 3 回だけ）

失敗系：テスト担当のコマンドを人間が却下 → その Worker が失敗 → Task `failed`（`worker_failed`、worktree は残る）→ Orchestrator は統合せず「統合は見送りました」と報告し、判断を `orchestrator.decision` に残す。

## シーケンス

```
Human(UI/client)      Daemon (dispatcher)            Orchestrator run (LLM)        Worker A / B (agent runs)
  | session.create(chat) |                                |                              |
  | grantOrchestration ->| grant(session, preset, maxWorkers 2, depth 1)                 |
  | session.send(goal) ->| run(kind=orchestrator) ------->|                              |
  |                      |<- orchestrator.recordDecision -|                              |
  |                      |<- task.create x2 --------------|                              |
  |                      |<- task.spawnWorker(A) ---------| worktree A, session A, run A ->| A: write docs, README
  |                      |<- task.spawnWorker(B) ---------| worktree B, session B, run B ->| B: write test, run cmd
  |                      |<- task.wait(all) ... (sleeps on bus)                          |
  |<- approval.requested ------------------------------------------------------------------| B asks (Bash, medium)
  | approval.respond --->|------------------------------------------------------------------>| B runs node --test
  |                      | run A/B completed -> commit + diff artifact -> task review x2   |
  |                      |-- task.wait returns ---------->|                              |
  |                      |<- integration.create/run ------|                              |
  |                      |   merge A, merge B, node --test -> awaiting_approval          |
  |                      |-- integration.wait returns --->|                              |
  |<- final report (Japanese, ids) -----------------------|                              |
  | integration.approve ->| (human only) fast-forward main                               |
```

## 入ったもの

- `task.spawnWorker`（Worker の起動、委譲 Grant と予算の切り出し、終了で Task を review / failed）、`task.wait`（any / all、TaskSnapshot）、`integration.wait`、`orchestrator.recordDecision`、`session.grantOrchestration`、`system.setupDemo`
- `orchestrator` Run の Executor（役割の system prompt + 同じ API ツール）と `mock/orchestrator`
- 承認 payload の `risk`、`/health` の `service` / `pid`
- UI：「デモモードで試す」で `system.setupDemo` → 目標を下書きに入れてデモのチャットを開く。詳細パネルに「Orchestrator にする」「このTaskを実行」
- 途中で見つけて直した継ぎ目：
  - コミット後フックの実行順。トランザクション内で `runs.start` した Run の起動イベントが、同じトランザクションで後から出したイベントより先に配信され、クライアントが `seq` で後者を捨てていた（Worker 起動時の `task.updated` が UI に届かない）。フックを 1 本のキューで登録順に実行するようにした
  - ツール一覧の作成が、見せないメソッドごとに `policy.denied` を出していた（チャット Run のたびに 20 件以上）。`PolicyEngine.peek` で記録しないようにした

## 既知の制約・残り

- 本物の LiteLLM + Claude Agent SDK での通しは未実施（テストは偽サーバと spy まで）。手順は `docs/persistent/development.md`「Vertical Slice を試す」
- Orchestrator は 1 回の Run の中で待ち続ける（`task.wait` は最大 10 分、繰り返す）。デーモン再起動で Orchestrator の Run は `interrupted` になり、計画の続きは自動では再開しない（Worker と Task の状態は残り、起動時に Task は照合される）
- `mock/orchestrator` の分解は固定（ドキュメント＋テストの 2 件）。目標の中身に応じた分解は本物のモデルの仕事
- Worker に Control API ツールはまだ渡していない（Claude ランタイムの `mcp__acc__*` は未接続）。委譲 Grant は付くので、接続すれば読み取り系だけ使える
- 統合のコンフリクトを Integrator に直させる流れ（concept §6.1 の 5）は未実装。Orchestrator は報告して止まる
- 「このTaskを実行」は Task がセッションに紐づいて見えているとき（Command Mode の項目）だけ出る。Worker 未起動の Task を一覧する画面はまだない
