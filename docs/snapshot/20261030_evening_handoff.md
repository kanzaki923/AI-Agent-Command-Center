# 2026-10-30 引き継ぎ（夕方）：右腕を本物で確かめ、透けを実機で通した

`20261030_right-hand_handoff.md` の続き。ブランチ `vertical-slice`、最後のコミットは `5a7ea00`。`pnpm check` 緑。

## 今日の後半に入ったもの

- **右腕を本物の Haiku 5.5 で確認**（`20261030_right-hand-real.md`）：仕様 §0 の 7 つの言葉が全部そのとおりに振り分いた。再現は `packages/daemon/scripts/real-right-hand.ts`。
- **コンテキストを軽く**（`20261030_right-hand-context.md`）：ツール Schema から検証だけのキーを落とす（全エージェント共通、−28%）、右腕は過去の実行を「言ったこと」で覚える（`assistant/history.ts`）、system prompt を固定部と状況の 2 つに。1 回の入力は約 6k ＋ 会話の文で一定。
- **右腕が自分から話す**（`assistant/notify.ts`）：根の木が終わった・失敗したら知らせを置いて右腕が 1 行で答える。ホームの欄の上に出る。
- **透け、実機で通った**：原因は index.html の不透明な下塗りと、半透明の地の 3 枚重ね。今は各領域が 1 枚だけ塗る。設定に `なし / 翼だけ / 全体` と `弱 / 中 / 強`。透けのときは文字のインク・塗り・罫線を一段濃く、ライトの tint を暗く。
- **モーダルの出現位置**：keyframes の translate 二重掛けを直した。
- **設定は 1 行に決め事 1 つ**（テーマ / 動き / 透け を別の行に）。

## 残っていること

- **プロンプトキャッシュ**：接頭辞の形は整えたが `cache_control` は付けていない。LiteLLM 経由で実測してから Gateway に入れる。
- **Sonnet / Opus での右腕**：Haiku でしか回していない。
- **名前**：「右腕」は作業名のまま UI に出ている（`ASSISTANT_TITLE`、`ui-design.md` §9.1）。
- 右腕の会話のモデルピッカーが既定モデルを表示する（実際に走るのは `settings.assistant.model`）。
- 繰り返しを頼むと右腕が題に「（毎朝9時）」を入れることがあり、レーンの時計と二重になる。プロンプトで一言添えれば直る。
- 右腕が立てた木を監査の撮影に足していない（レーンの菱形の印は単体テストだけ）。
- 透けの各段階の数値（`--glass-wing` / `--glass-main`）は実機で「翼だけ・中」と「全体・弱」を見ただけ。「全体・強」の読みやすさは未確認。
- 監督役にも「言ったことで覚える」を適用するかは、右腕の手応えを見てから。

## 試し方

```sh
pnpm dev:desktop                                   # 透けは実機だけ。右腕は LiteLLM 未設定なら mock/right-hand
ACC_LITELLM_API_KEY=<キー> node --import tsx packages/daemon/scripts/real-right-hand.ts claude-haiku-5-5 <出力>
node apps/desktop/e2e/audit.js --out <dir>         # 24 枚（右腕の 2 枚を含む）
```
