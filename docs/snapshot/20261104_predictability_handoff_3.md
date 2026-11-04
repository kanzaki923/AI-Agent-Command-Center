# 2026-11-04 引き継ぎ（3）：予測できない動きを減らす・締め

`20261104_predictability_handoff_2.md` の続き。ブランチ `vertical-slice`、`pnpm check` 緑。

## このあと入ったもの

- `5ad0000`（別の作業、`ai-conversations` から早送りで取り込み）：キャラクターを持つ AI 同士の会話。`session.send` の `forward` など。`docs/snapshot/20261104_ai-conversations_handoff.md`。
- `f6e0f80` **作業場所の切り替えをデーモンが強制**：ホームの切り替えは `自動（右腕が決める）`（既定）・フォルダ・コード。フォルダ・コードは `session.send` の `workPlace { kind, projectId }`（`meta.hint.place`）で渡り、`assistant.startWork` が右腕の指定より優先する（モデルの `workModel` と同じ）。プロジェクトにその場所がなければ何も始めない。

## 確かめたこと

- 監査の場面（`pnpm --filter @acc/desktop e2e:audit -- --serve`）をブラウザで開き、ホームの作業場所の 3 つのラベルと、既存の繰り返しの `変更`（選ぶまで押せず、選ぶと押せる）を確認した。
- トースト・任せ方の注記・戻るはユニットテストで確かめた（画面では見ていない）。

## 残っていること

1. **OS の通知を押しても会話が開かない**（Tauri / Windows）。`tauri-plugin-notification` はデスクトップでクリックを返さない。Rust 側で `on_activated` を受けてウィンドウを出し、イベントで `lib/notify.ts` の `onClick` を呼ぶ形。実機の通知で確かめる必要がある。
2. 細かいもの（このままでよいと判断）：レーンの `+N` は根の会話を開く、`Ctrl+F` は画面で意味が変わる。
