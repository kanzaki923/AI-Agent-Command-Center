# 2026-11-26 本物の Claude Code でリードを確かめた

`packages/daemon/scripts/real-lead.ts`（一時 `ACC_HOME`、手元の Claude Code のログイン、`claude-sonnet-5-5`）。小さなリポジトリ（`src/math.js`・`text.js`・`date.js` が TODO）で、コードの会話に「3 つは独立しているので並列で進めて。テストも付けて」と頼んだ。

## 起きたこと

約 1 分で、取り込みが承認待ちになるところまで進んだ。推定の費用は $0.64。

1. 親は `ToolSearch` で acc のツールを読み込み、`Bash` でファイルを 2 回見た。そのあと `mcp__acc__session_spawn` を 3 回呼んだ。
2. 子 3 つがそれぞれ自分の worktree（`acc/math-js-add-clamp-…` など）で並列に動き、20〜30 秒で完了した。各自がコードとテストを書いた。
3. 親は `[状況の更新]` で起こされた。1 回目（1 人完了）は「残りを待つ」と書いてターンを終えた。2 回目（残り 2 人）で `integration_create`（3 タスク・4 マージ。子 3 つ＋自分）と `integration_run` を呼んだ。
4. `node --test` が通り、取り込みは `awaiting_approval` になった。

## 見つけて直したこと

- **子が自分で `git commit` した**。そのため終了時にデーモンがコミットするものがなく、diff が記録されなかった。成果物は「文書」（最後の回答）になり、確認待ちにもならなかった。
  - Task の実行は、コミットがなくても作業場所の diff が前の記録と違えば diff を記録するようにした（`runtime/executor.ts`）。

## 気になったこと（未対応）

- 親の最後の返事が「いまはマージ実行中です」だった。実際はもう承認待ちだった。`integration_run` はすぐ返るので、その直後の状態を書いている。
