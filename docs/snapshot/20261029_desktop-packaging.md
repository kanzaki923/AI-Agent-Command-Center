# 2026-10-29 デスクトップアプリのパッケージング（track/desktop-packaging）

ダブルクリックで起動できるアプリにした記録。アプリは Core Daemon を起動（または既存を再利用）して UI を出し、閉じてもデーモンは残る。実際にビルドした exe を一時 `ACC_HOME` で動かして確かめた。

## 決めたこと

| 項目 | 決定 | 理由 |
|---|---|---|
| デーモンの配布形 | esbuild で `packages/daemon/src/main.ts` → `resources/daemon/main.mjs`（ESM 1 ファイル 3.0MB + source map）。`require` は `createRequire` の banner で用意 | node_modules を持ち込まずに済む。依存（ws・zod・Agent SDK の JS）は Node 組み込みしか import しないので全部入る |
| Claude Agent SDK | SDK の JS はバンドルに含める。**SDK 同梱の CLI（`claude.exe` 約 285MB）は同梱しない**。デーモンが Run ごとに実行ファイルを探して `pathToClaudeCodeExecutable` で渡す（`ACC_CLAUDE_CODE_PATH` → バンドル隣の `claude/` → SDK のプラットフォーム別パッケージ → `PATH` → `~/.local/bin`）。無ければ `available()` が日本語の理由を返し、その Run は理由つきで失敗する | SDK は `createRequire(import.meta.url).resolve('@anthropic-ai/claude-agent-sdk-<os>-<arch>/claude.exe')` で CLI を探すため、バンドル内では必ず失敗する。node_modules の一部を同梱する案はインストーラが 300MB 近く増え、mock / LiteLLM チャットだけ使う人にも負担になる。版を揃えたい人向けに `prepare-sidecar.js --with-claude-code` で同梱もできるようにした（バンドル隣の `claude/` が優先される） |
| Node ランタイム | 公式 Node **22.23.3** を `externalBin`（`acc-node.exe`）に。`prepare-sidecar.js --release` が nodejs.org から取得し、スクリプトに固定した SHA-256（`SHASUMS256.txt` から写したもの、6 ターゲット分）で検証してビルドキャッシュ（`%LOCALAPPDATA%\acc-build-cache`）に置く。以降はキャッシュを再検証して使う | 署名済み公式バイナリ（OpenJS Foundation）を、リポジトリにハッシュを固定した上で使う。TOFU にしない。キャッシュをリポジトリ外に置くので worktree をまたいでもオフラインでビルドできる |
| `tauri build` との結合 | `beforeBuildCommand` = `pnpm build && node scripts/prepare-sidecar.js --release` | `tauri build` を直接叩いても sidecar とバンドルが必ず最新になる |
| 開発時の sidecar | `prepare-sidecar.js`（引数なし）は sidecar が**無いときだけ**手元の node をコピー | 以前はサイズ比較で毎回上書きしていたため、release 用の固定版を dev 版で潰していた |
| `resource_dir()` のパス | `dunce::simplified` で `\\?\` を外して node に渡す | Node 22.23.3 は `\\?\C:\...\main.mjs` を main に渡すと `EISDIR: lstat 'C:'` で即死した（下記「踏んだもの」1）。dunce は既に Cargo.lock にあった |
| デーモンの node フラグ | `--disable-warning=ExperimentalWarning --enable-source-maps` | バンドルでは ESM の import が巻き上がり、`main.ts` の警告フィルタより先に `node:sqlite` が読まれる。ログのスタックトレースを TS に戻すため source map も同梱 |
| 起動失敗の表示 | Rust のエラーを日本語にし、**今回の起動分だけ**のログ末尾（行頭から、1500 バイト）を付ける。`daemon-launch.log` は 5MB を超えたら `.1` に回す | 以前は過去の失敗も含めたログ末尾を行の途中から出していた。detach したデーモンの出力は全部このログに入り続けるので上限を設けた |
| 二重起動の契約 | デーモンは「同じ `ACC_HOME` に生きたデーモンがいる」なら exit 0。bind に負けたら 3 秒まで勝者の `daemon.json` を待って exit 0、別プログラムがポートを使っていれば exit 1 | ランチャー（Rust）は exit 0 を「他が担当」とみなしてポーリングを続ける契約（調査メモ）に合わせた。以前は exit 1 でアプリがエラー表示になり得た |
| デーモンの停止 | `system.shutdown { force }`（人間だけ。`tool: false`。Run 実行中は `force` なしで `conflict`）。応答後 50ms でサーバ → `daemon.json` → モジュール → DB を閉じ、`Daemon.closed` で `main.ts` が exit。CLI は `acc daemon stop [--force]`（プロセスの終了まで待つ） | UI を閉じても残るデーモンを、止める手段が「タスクマネージャーで kill」しか無かった。kill だと DB と `daemon.json` が後始末されない |
| 開発コマンド | `pnpm dev:desktop` = 既存デーモンが無ければ `tsx watch` のデーモン → `/health` を待って `tauri dev`。閉じる / Ctrl+C で `acc daemon stop --force` → watch とアプリのプロセスツリーを止める。従来のブラウザ版は `pnpm dev:web` に改名。`pnpm build:desktop` = release + NSIS | 1 コマンドで「ソース変更が反映されるデーモン + アプリ」。シェルが自前で detach 起動した古いデーモンにつながる事故（調査メモの「開発時の運用」）を避ける |
| スナップレイアウト | 入れない（Win+Z、端へのドラッグ、Win+矢印、ダブルクリック最大化で代替） | 枠なしウィンドウで最大化ボタンのホバーにフライアウトを出すには、WebView2 の上で `WM_NCHITTEST` に `HTMAXBUTTON` を返す仕組み（`tauri-plugin-decorum` 相当）が要る。サードパーティ依存と自前のキャプションボタンとの二重管理になるので見送り |

## 検証（実際に動かしたもの）

環境：Windows 11 / rustc 1.89 / Node 22.18（開発）/ 同梱 Node 22.23.3。他のエージェントと衝突しないよう `ACC_HOME=<scratchpad>\acc-home-verify`、`ACC_PORT=47931`、`WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9333` で起動し、Playwright の `chromium.connectOverCDP` で本物のウィンドウの DOM を読んだ（Tauri の IPC も `window.__TAURI_INTERNALS__.invoke` で直接呼んで `get_connection` / `is_maximized` を確認）。

### テスト

- `pnpm check`（lint・typecheck・vitest 全 430+ 件）、`cargo test --lib`（6 件）、`pnpm --filter @acc/desktop e2e:slice` → PASS（full vertical slice）。
- 追加したテスト：`system.shutdown`（WS 越しに応答してから停止・`daemon.json` 削除、SYSTEM と `"*"` Grant の agent は `forbidden`、Run 実行中は `conflict` / `force` で停止）、CLI `daemon stop`（引数、`--force` の案内、終了待ち、未起動なら 0）、Claude Code の探索順と日本語の理由、Runtime が見つけたパスを SDK に渡す / 見つからなければ Run 前に失敗、**バンドルの実起動**（`bundle.test.ts`：esbuild → 素の node で起動 → `/health` → 同じ `ACC_HOME` の 2 つ目は exit 0 → デモの git リポジトリで Claude ランタイムの agent Run が `ACC_CLAUDE_CODE_PATH` の理由で失敗＝SDK の JS がバンドル内で読み込めている → `system.shutdown` で exit 0・`daemon.json` 削除）、`prepare-sidecar`（ターゲット対応表、全ターゲットのハッシュ固定、1 度だけ取得してオフラインはキャッシュ、ハッシュ不一致は拒否・改ざんされたキャッシュは再取得、dev 版 node は固定版で置き換え）、Rust（ログの回転、今回分だけのログ末尾、日本語のエラー）。

### Node の取得とオフライン

- `node scripts/prepare-sidecar.js --release`：初回 `downloaded, verified`（約 11 秒、`win-x64/node.exe` 86,973,768 バイト、署名者 `CN=OpenJS Foundation`、`--version` → `v22.23.3`）。
- `binaries/` を消し、`fetch` を常に失敗させる `--import` フックを付けて再実行 → `from cache, verified` で復元。もう一度 → `up to date`。
- `git status --ignored`：`apps/desktop/src-tauri/binaries/` と `resources/` は ignored。キャッシュはリポジトリ外。

### ビルド

- `pnpm --filter @acc/desktop tauri build --debug`：Vite → sidecar（up to date）→ バンドル 3.0MB → cargo 50 秒（2 回目 22 秒）→ NSIS（初回は NSIS 3.13 と nsis_tauri_utils を GitHub から取得、ハッシュ検証つき）。`AI Agent Command Center_0.1.0_x64-setup.exe` 45.75MiB。`target/debug/` に `acc-desktop.exe`・`acc-node.exe`・`daemon/main.mjs(.map)` が並ぶ。
- release（`pnpm build:desktop`）：下記「release ビルド」。

### 実アプリ（debug exe、同梱 Node + バンドル経路）

1. **初回（失敗→修正）**：起動したが UI に「Core Daemon が起動直後に終了しました（exit code: 1）」と Node の `EISDIR: lstat 'C:'` が表示された（エラー表示の経路自体は正しく動いた）。`resource_dir()` の `\\?\` パスが原因で、dunce で修正して再ビルド。
2. **(a) デーモン無しで起動**：`acc-node` 0 個の状態から起動 → 3.6 秒で `daemon.json`（初回起動の exe スキャン込み）。ログ上はデーモンの起動から ready まで約 35ms。`acc-node.exe` の親は `acc-desktop.exe`、コマンドラインは `acc-node.exe --disable-warning=ExperimentalWarning --enable-source-maps <target>\debug\daemon\main.mjs`（`\\?\` なし）、コンソール窓なし。`/health` → `{"ok":true,"service":"acc-daemon","pid":…}`。
3. **(b) UI が接続**：CDP で `title = "AI Agent Command Center"`、`url = http://tauri.localhost/`、`get_connection` は同じ pid・`spawned: false`（pre-warm 済み）、ステータスは「接続中」、オンボーディングが表示。続けて「デモモードで試す」→ 目標を送信 → Orchestrator と Worker 2 人が動き「承認待ち 1・統合待ち 1・実行中 2」になった（同梱 Node 上で git worktree・mock ランタイム・承認まで動く）。
4. **ウィンドウ操作**：「最大化」ボタン → `is_maximized: true`。「閉じる」ボタンでアプリ終了。
5. **(c) 閉じてもデーモンは残る**：`acc-desktop` 0 個、`acc-node` は同じ pid で生存、`/health` 応答。`ACC_HOME` を合わせた `acc status` が「稼働中・実行中 2」、`acc events` で Worker の完了イベントが UI を閉じた後も進んでいた。
6. **(d) 再起動で再利用**：再度起動 → `get_connection` は同じ pid・`spawned: false`、`acc-node` は 1 個のまま、ログの「core daemon ready」も 1 回だけ。window-state で**最大化が復元**された。
7. **single-instance**：起動中に 2 つ目を起動 → 195ms で exit 0、プロセスは 1 個のまま。
8. **UI を開いたまま停止**：`acc daemon stop` → 「実行中の Run が 2 件あります…」で exit 1。`--force` → 「停止しました（pid …）。実行中だった Run 2 件は中断しました」。数秒後、UI が自動で `get_connection` し直して**新しいデーモン（別 pid）を起動**し、中断になった Run を表示した。
9. 後片付け：「閉じる」→ `acc daemon stop --force` → `acc-desktop` / `acc-node` 0 個、`daemon.json` 削除済み。

### `pnpm dev:desktop`

一時 `ACC_HOME` で実行：`[daemon]` 行で tsx watch のデーモンが ready → `[desktop]` 行で Vite と `tauri dev`（cargo 25 秒）→ ウィンドウは `http://127.0.0.1:5173/` を表示し、`get_connection` は watch のデーモンの pid（`spawned: false`、`logs/daemon-launch.log` が作られていない＝シェルは何も起動していない）。「閉じる」で「Core Daemon を停止しました」→ スクリプト終了（exit 0）、`/health`・Vite とも応答なし、このワークツリーのプロセスは残っていない。

### release ビルド

`pnpm build:desktop`：cargo release（LTO、依存込み）4 分 52 秒、`acc-desktop.exe` 23.8MB、`AI Agent Command Center_0.1.0_x64-setup.exe` 43.12MiB（同梱 Node 87MB を LZMA で圧縮）。別の一時 `ACC_HOME` で release の exe を起動（コンソール窓なし）→ 3.0 秒で `daemon.json`（新しい exe の初回スキャン込み）、CDP で `http://tauri.localhost/`・接続済み → 「閉じる」で `acc-desktop` 0 個・`acc-node` 1 個 → 再起動で同じ pid・`spawned: false`・`acc-node` 1 個のまま → 閉じて `acc daemon stop --force` → どちらも 0 個。

## 踏んだもの

1. **Node 22.23 と `\\?\` パス**：調査時（Node 22.18）は `\\?\C:\...` の main を扱えたが、固定した 22.23.3 では `realpathSync` が `lstat 'C:'` で `EISDIR` になり即終了した。Rust 側で `dunce::simplified` を通す。
2. **CDP の合成ダブルクリックではタイトルバーの最大化が起きない**：Tauri のドラッグ領域は 1 回目の mousedown で `start_dragging`（OS のドラッグループ）に入るため、CDP が送る 2 回目の mousedown（`detail = 2`）が届かない。実マウスでのダブルクリック最大化は調査時に確認済み。今回はキャプションボタン（最小化以外）を CDP で確認した。
3. Python で編集したファイルが CRLF になった（Windows の text モード）。`.gitattributes` で LF に揃うが、作業中は LF に戻した。

## 残り

- NSIS インストーラは作ったが、実際のインストール（`%LOCALAPPDATA%` への配置、スタートメニュー、アンインストール）は試していない（ユーザー環境を変えるため）。インストール先から起動したときの `resource_dir()` は exe の隣で、今回の検証と同じ経路のはず。
- アップデート時は `acc-node.exe` が動いていると上書きできない。インストーラ／updater 導入時に `system.shutdown` を呼ぶ（NSIS フックか updater の前処理）。
- Claude Code CLI と SDK（0.3.312 → CLI 2.1.312）の版が一致しない場合の互換性は未確認（手元の Claude Code を使う経路）。不一致を `available()` で検知して警告する余地がある。
- `/health` にバージョンを載せ、アプリ更新後に古いデーモンが残っていたら「アイドル時に再起動」する仕組みは未実装。
- コード署名なし（SmartScreen の警告が出る）。macOS / Linux のビルドは未確認（スクリプトとハッシュは用意した）。
- スナップレイアウトのフライアウト（上記）。トレイ常駐（「バックグラウンドで動作中」表示・デーモン停止メニュー）は未実装で、今は CLI で止める。
- 同時起動でポート bind に負けたデーモンは、負けが分かる前に `createDaemon`（マイグレーション・起動時リカバリ・モジュール開始）を済ませている。起動直後なので実害はないが、bind を先にする方がきれい。
