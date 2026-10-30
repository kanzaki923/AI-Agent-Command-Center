# 2026-10-30 右腕を本物のモデル（Haiku 5.5）で動かした

`20261030_right-hand_handoff.md` の「残っていること」の 1 つ目。ユーザーの許可を得て、別プロジェクトの API キー（環境変数名だけをスクリプトに渡し、値は表示・保存していない）で `claude-haiku-5-5` を右腕にした。LiteLLM は立てず、Gateway を Anthropic の OpenAI 互換エンドポイント（`https://api.anthropic.com/v1`）に直接向けた（`Authorization: Bearer` と `/chat/completions` の形が同じ）。

## やり方

```sh
cd packages/daemon
ACC_LITELLM_API_KEY=<キー> node --import tsx scripts/real-right-hand.ts claude-haiku-5-5 <出力ファイル>
# LiteLLM を通すなら ACC_LITELLM_BASE_URL も（既定は https://api.anthropic.com/v1）
```

`scripts/real-right-hand.ts`：一時 `ACC_HOME` にデーモンを起動（キーはデーモンと同じ環境変数名で、そのプロセスにだけ）、`settings.assistant.model` を指定のモデル、`defaultModel` を `mock/orchestrator`・`defaultRuntime` を `mock` にして、右腕が立てる木は費用なしで動かす。日次上限は $1。7 つの言葉を順に送り、返事・ツール呼び出し・費用・木の状態を書き出す。

## 結果（2 回目。状況ブロックに子と出番を足したあと）

| 言葉 | 右腕がしたこと | 返事 | 費用 |
|---|---|---|---|
| 来月のローンチ準備を進めて。競合の価格、FAQ、告知文をお願い | `assistant.startWork {title: "来月のローンチ準備", delegate: true}`。言葉はそのまま | 「来月のローンチ準備」を始めます。終わったら知らせます。 | $0.0020 |
| 今どう？ | ツールなし（状況ブロックから） | 「来月のローンチ準備」は作業中です。競合の価格、FAQ、告知文の3件がいずれも準備中で、完了はまだ0件です。 | $0.0010 |
| Excel で A 列の重複を消すには？ | ツールなし | 2 文で手順 | $0.0010 |
| このフォルダの README を整えて（hint: フォルダ …） | `assistant.startWork {delegate: false, workspace: {kind: folder}}` → agent の会話 1 本 | 「README を整える」を始めます。終わったら知らせます。 | $0.0023 |
| ローンチ準備は止めて | `session.stop {tree: true, reason}` | 「来月のローンチ準備」を止めました。再開するときは「再開して」と言ってください。 | $0.0023 |
| 毎朝 9 時に昨日のまとめを作って | `assistant.startWork {delegate: false}` → `schedule.create {cron "0 9 * * *", tz Asia/Tokyo}` | 毎朝 9 時（日本時間）に「昨日のまとめ（毎朝9時）」を作るように設定しました。最初の実行は 2026-10-31 9:00 (JST) です。 | $0.0037 |
| ローンチ準備を再開して。FAQ は 5 問でいい | `session.resume {tree: true}` と `session.send {content: "FAQ は 5 問でいい。"}` を同じターンで | 「来月のローンチ準備」を再開し、「FAQ は 5 問でいい」と伝えました。 | $0.0027 |

右腕の分は合計 $0.015（1 回目は $0.018）。1 往復 1〜6 秒。失敗・拒否・ループなし。

## わかったこと

1. **仕様 §0 の表はそのまま成立した。** 新しい仕事は木を立てて「始めます」、質問は 1〜2 行、止める・再開、繰り返し、普通の質問、どれも Haiku で正しく振り分けた。ヒント（作業場所）も `workspace` に正しく載せた。
2. **状況ブロックに子と出番の行を足したら、「今どう？」がツールなしで返るようになった。** 1 回目は木ごとに 1 行だけだったので `session.tree` を呼びに行っていた（$0.0022・5 秒 → $0.0010・1.3 秒）。
3. **1 回目の hint は私の台本のミス**（フォルダを `ACC_HOME` の中に置いた → 「アプリのデータフォルダは作業場所にできません」）。右腕は worktree で試し直してから、理由を 2 文で返した。拒否の文がそのまま役に立つ。
4. **入力トークンは 1 回 10k〜34k**（ツール 19 個の JSON スキーマが大半。履歴が伸びるとさらに増える）。Haiku では $0.001〜0.004 だが、Sonnet なら 1 往復 $0.03〜0.1 になる。キャッシュ（OpenAI 互換の層で `cache_control` が効くか）か、ツールの説明の圧縮が次の手。
5. 繰り返しの `prompt` は右腕が言い換えた（「昨日のまとめを作ってください。…」）。`text` を言い換えない規則は `assistant.startWork` にだけ書いてあるので、仕様どおり。題に「（毎朝9時）」を含めるのは親切だが、レーンの時計と重なる。プロンプトで「題に周期を入れない」と言えば消える（まだ入れていない）。
6. `session.stop` に `reason`、`session.resume` に `message` を付けてきた。API にある引数は使ってくる。

## まだ

- Sonnet / Opus での判断の違い、長い履歴（200 件）での費用。
- 右腕が自分から話す（木が全部終わった・失敗が続いた）。
- LiteLLM 経由（本物の LiteLLM で `usage.cost` が `reported` になる経路）では今回は試していない。
