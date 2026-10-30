# 2026-10-30 引き継ぎ：右腕を入れた

## いまの状態（ブランチ `vertical-slice`）

`20261030_right-hand-spec.md` の §1〜§3 を実装した。ホームの入力欄の相手は右腕（権限を持った 1 本の会話）になり、◇（任せる）は消えた。`pnpm check` 緑。監査の撮影 24 枚（`14-home-assistant`・`62-assistant` を足した）を目で確認。

入ったもの：

- **Core Daemon `assistant/`**：`system.assistant`（なければ作る。何が右腕かは `reason: assistant` の Grant で決まる）、`assistant.startWork`（create → delegate → send をデーモンに。右腕からは 1 Run に 3 本まで）、Grant（`ASSISTANT_PERMISSIONS`、`scope.allSessions`）、右腕のモデル順序と日次上限（`settings.assistant`、既定 $2）、system prompt に全部の木の状況（`statusBlock`）、`mock/right-hand`。`home.get` は右腕を木に入れない。`session.send` に `hint`（会話に出ない 1 行。作業場所の希望）。
- **権限の土台**：`GrantScope.allSessions`（自分の木の外にも届く。委譲は親が持つときだけ）。`session.list` / `session.tree` / `cost.summary` / `assertAgentMayStartRun` がそれを見る。
- **UI**：`HomeComposer` は右腕に送るだけ（Enter で留まる、Ctrl+Enter で右腕の会話を開く）。`AssistantLine`（欄の上に最後の 1 往復。題を押すとレーンへ。失敗理由も同じ場所）。サイドバーの固定行「右腕」（未読の点つき）。レーンの役割アイコンの右下に「右腕が始めた」の菱形。費用の内訳に右腕の行。設定に「右腕の上限」。右腕の会話には任せる・繰り返すを出さない。`startConversation`（パレットの AI に頼む）は `assistant.startWork` を呼ぶだけ。
- **文書**：`ui-design.md` §4.2・§5.1・§5.2・§8.2・§8.6・§9.1、`architecture.md` §2.3・§2.4・§2.11・§2.19・§2.20、`development.md`。

## 仕様（`20261030_right-hand-spec.md`）から変えたところ

- 右腕が運んだ最初のメッセージの `author` は人ではなく system の `assistant`（正直なデータ）。`HomeTree.goal` と `startedBy: 'assistant'` はこれを読む。
- 作業場所のヒントは `session.send` の `hint` → `meta.hint` → 右腕の system prompt の 1 行。
- プロンプトの文面は `orchestrator/` ではなく `assistant/prompt.ts`（右腕は指揮役ではないので別の場所のほうが読みやすい）。
- 繰り返しの依頼では、右腕が `assistant.startWork {delegate: false}` で会話を作ってから `schedule.create` をその会話に付ける（定期実行は会話を持ち主にするため）。その会話は最初の言葉に 1 回だけ答える。

## 試し方

```sh
pnpm dev:desktop                           # ホームの欄に「来月のローンチ準備を進めて」「今どう？」「ローンチ準備を止めて」
node apps/desktop/e2e/audit.js --serve     # 場面を立てたまま（右腕は mock/right-hand）
node apps/desktop/e2e/audit.js --out <dir> # 24 枚を撮る
```

## 残っていること

- **本物のモデルでの手応え**。`mock/right-hand` は文の形で分けるだけ。LiteLLM 経由で `settings.assistant.model`（未設定なら既定のモデル）に実際に判断させて、プロンプト（`assistant/prompt.ts`）の言葉を直す。とくに「新しい仕事」と「質問」の切り分け、`delegate: false` にする判断、`hint` の使い方。
- **右腕が自分から話す**（spec §4 の 3）：木が全部終わった・失敗が続いたときに声をかける。監督役の `inbox` を右腕にも広げるかはここで決める。
- 右腕の会話のモデルピッカーは `session.model`（空）＝既定のモデルを表示するが、実際に走るのは `settings.assistant.model`。右腕のときだけ表示をそろえる。
- 右腕が立てた木を `ホーム` の撮影に足していない（場面の 3 本は人が立てたまま）。レーンの菱形の印は単体テストだけ。
- 名前。「右腕」は作業名のまま UI に出ている（`ASSISTANT_TITLE`、`ui-design.md` §9.1）。
- 透けの実機確認（前回から持ち越し。`20261030_ui-rework_handoff.md`）。
