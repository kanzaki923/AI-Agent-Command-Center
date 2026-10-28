# Tauri シェル調査・プロトタイプ（2026-10-29）

Desktop シェル（Tauri 2）の構成と、Core Daemon の「起動していなければ起動して接続、UI を閉じても止めない」挙動を、リポジトリ外のプロトタイプで実際に動かして確かめた記録。末尾に `apps/desktop/src-tauri` へそのまま置けるファイル一式を載せる。

## 結論（先に要点）

- **構成**：Tauri 2（crate 2.11 系）＋ プラグインは `single-instance` / `window-state` / `opener` の 3 つだけ。`tauri-plugin-shell` は**使わない**（デーモン起動は Rust の `std::process` で行う。detach 用のフラグを細かく指定する必要があり、JS 側に任意プロセス起動の権限を開ける理由もないため）。
- **接続**：Rust コマンド `get_connection()` が `~/.acc/daemon.json` → `GET /health`（`service == "acc-daemon"` かつ `pid` 一致）で生存確認し、ダメなら detach 起動 → `daemon.json` と health を 100ms 間隔でポーリングして `{ url, wsUrl, token, pid, spawned }` を返す。アプリ起動直後（`setup`）にも先行起動（pre-warm）しておく。
- **Windows の detach**：`CREATE_NO_WINDOW | CREATE_NEW_PROCESS_GROUP | CREATE_BREAKAWAY_FROM_JOB`（breakaway が拒否されたら外して再試行）。`DETACHED_PROCESS` は使わない。加えて**自プロセスの標準ハンドルの継承フラグを外してから spawn する**（理由は「ハマりどころ」1）。
- **配布**：公式 `node.exe` を `externalBin`（`acc-node.exe`）として同梱し、esbuild で 1 ファイルにした daemon を `resources/daemon/main.mjs` に置く。Node SEA は今は採らない。
- **見た目**：`decorations: false` ＋ HTML のカスタムタイトルバー（`data-tauri-drag-region` と自前のキャプションボタン）、`shadow: true`、`visible: false` ＋ `backgroundColor` で起動時の白フラッシュを防ぐ。Mica は MVP では入れない（後から設定だけで足せる）。
- **検証**：`cargo check` / `cargo test` / `tauri build --debug --no-bundle` / `tauri build --no-bundle`（release）が通り、実アプリで「起動 → デーモン自動起動 → IPC → WebSocket 接続 → ウィンドウを閉じる → デーモンは生き残る」「UI を強制終了してもデーモンは生き残る」「2 つ目の起動は既存ウィンドウにフォーカスして即終了」を確認した。

## 1. 環境と計測

| 項目 | 結果 |
|---|---|
| ツールチェーン | rustc 1.89.0 (MSVC) / Node 22.18.0 / pnpm 10.14 / `@tauri-apps/cli` 2.12.4 |
| 解決された crate | tauri 2.11.6, tauri-build 2.6.3, wry 0.55.1, tao 0.35.3, plugin-opener 2.5.5, plugin-window-state 2.4.1, plugin-single-instance 2.4.5 |
| `cargo check`（初回、crate の一部はキャッシュ済み） | 1分38秒 |
| `cargo test --lib`（初回） | 1分29秒 / 2回目以降 4秒 |
| `tauri build --debug --no-bundle`（check 後） | 約30秒 / 差分ビルド 約10秒 |
| `tauri build --no-bundle`（release、LTO・codegen-units=1） | 3分12秒（依存の release ビルド込み） |
| exe サイズ | debug 13.9MB / release 3.4MB（＋同梱 node.exe 85MB） |
| 起動（debug ビルド） | プロセス開始 → `run()` 0.7秒、`run()` → `setup` 0.5秒、デーモン spawn → healthy 0.23秒、フロントの初回 `get_connection` 0.2秒（pre-warm 待ち）、2 回目 5ms |
| 起動（release ビルド） | プロセス開始 → デーモン listen 0.7〜1.0秒（新しい exe の初回だけ Defender のスキャンで 1.7秒）、フロントの初回 `get_connection` 0.2〜0.3秒、2 回目 4ms |
| 同梱 node の起動 | `acc-node.exe -e 0` 約50ms（システムの node と同等） |

## 2. ハマりどころ（実際に踏んだもの）

1. **detach したデーモンが親の標準出力パイプを握り続ける**。Rust の `std::process::Command` は `bInheritHandles=TRUE` で起動するため、子の stdio をファイルに向けても、親が継承可能な標準ハンドル（ターミナルや `tauri dev` から渡されたパイプ）を持っていると、それもデーモンに継承される。結果、UI が終了してもパイプが閉じず、`acc-desktop.exe | cat` が永久に終わらなかった（デーモンを kill した瞬間に終了）。`tauri dev` やスクリプトからの起動でハングする原因になる。**spawn 前に `SetHandleInformation` で自分の std ハンドルの `HANDLE_FLAG_INHERIT` を外す**ことで解消（`daemon.rs` の `clear_std_handle_inheritance`）。
2. **最新の Tauri（2.12 系）は rustc 1.90 を要求**する。この環境は 1.89 なので、`Cargo.toml` に `rust-version = "1.89"` と `resolver = "3"`（MSRV を考慮した依存解決、cargo 1.84+）を書いて 2.11 系に落とした。Rust を上げたら `rust-version` を上げて `cargo update` するだけでよい。`Cargo.lock` はコミットする。
3. **JS パッケージと crate のマイナーバージョンを揃える**。Tauri CLI はビルド時に `@tauri-apps/api` / プラグイン JS と crate の major.minor 不一致を検査する。crate が 2.11 系なので `@tauri-apps/api ~2.11.1`、`@tauri-apps/plugin-opener ~2.5.5`、`@tauri-apps/plugin-window-state ~2.4.1` に固定する（CLI 自体は 2.12.4 で問題なかった）。実際に `@tauri-apps/api@2.12.4` を入れると `Found version mismatched Tauri packages` でビルドが止まり、2.11.1 に戻すと通ることを確認した。
4. **ヘルスチェックの HTTP**。Node の `http` は Content-Length 無しの応答を chunked で返すので、素朴に本文を JSON パースすると失敗し、20 秒タイムアウトした。HTTP/1.0 で問い合わせる＋本文の最外 `{...}` を取る形にした。デーモン側も `/health` は `Content-Length` 付きで返すとよい。
5. **同期コマンドはメインスレッドで動く**。`#[tauri::command] fn` を同期で書くと、デーモン起動待ちの間ウィンドウが固まる。`async fn` ＋ `spawn_blocking` にする。
6. **二重起動（プロセス内）**。React StrictMode の二重実行や pre-warm と初回呼び出しが重なると 2 回 spawn しうる。`ensure()` を `static Mutex` で直列化した（実測：pre-warm 中の呼び出しは待ってから既存接続を返し、`spawned=false`）。
7. **二重起動（プロセス間：UI と CLI が同時に起動）**はシェルでは防げないので、**デーモン側で解決する**契約にした：bind に失敗（`EADDRINUSE`）したら既存デーモンに任せて exit 0、`daemon.json` は listen 成功後に一時ファイル → rename で原子的に書く。シェルは子が exit 0 で終わってもポーリングを続け、勝者に接続する（テストで確認）。
8. **`externalBin` と `resources` は実在しないとビルドが落ちる**（`cargo check` や `tauri dev` でも build.rs が検査する）。実際に sidecar を消すと `cargo check` が `resource path ... doesn't exist` で失敗した。`resources/daemon/` は空ディレクトリなら通る。 開発時は `scripts/prepare-sidecar.mjs` が手元の node をコピーして用意する。`binaries/` と `resources/daemon/` は `.gitignore` に入れる。
9. **`resource_dir()` は `\\?\C:\...` 形式（verbatim パス）を返す**。node は問題なく扱えたが、`cmd.exe` や一部ツールに渡すと失敗しうる。デーモンに渡す引数は今はこのままで動くが、他ツールへ渡すなら `dunce::simplified` を通す。
10. **Job オブジェクト**。この作業環境のシェルは Job の中にいて `CREATE_BREAKAWAY_FROM_JOB` は拒否された（再試行で起動はできる）。この Job は kill-on-close ではなかったのでデーモンは生き残ったが、kill-on-close の Job（一部の IDE ランナーや CI）配下で UI を起動するとデーモンも道連れになる。通常のエクスプローラー起動では Job に入らない。
11. **タスクマネージャーの「プロセスツリーの終了」はデーモンも殺す**（親 PID 関係は detach しても残る）。必要になったら、短命のランチャーを挟んで親子関係を切る。今は対応しない。
12. **WebView の Origin は `http://tauri.localhost`**（Windows、`useHttpsScheme: false`）。デーモンの WS / HTTP は Origin 許可リスト（`http://tauri.localhost`、`https://tauri.localhost`、`tauri://localhost`、`http://localhost:5173`）で検査する。`useHttpsScheme` を後から変えると Origin が変わり localStorage / IndexedDB が消えるので、最初に決めて固定する。
13. `debug` ビルドは `windows_subsystem` が console なので、エクスプローラーから起動すると黒窓が出る（release では出ない）。

## 3. デーモンの起動方法の選択

`launch_spec()` の優先順：

1. `ACC_DAEMON_ENTRY=<file>`：`node <file>`（`.ts` なら `--import tsx`）。開発・テスト用の逃げ道。
2. `tauri dev`（`tauri::is_dev()`）：`node --import tsx src/main.ts`、cwd は `packages/daemon`（tsx をそこの node_modules から解決するため）。リポジトリのパスはコンパイル時の `CARGO_MANIFEST_DIR` から辿る（バイナリに埋まるだけでコミットされない）。
3. ビルド済みアプリ：exe の隣の `acc-node.exe` ＋ `resource_dir()/daemon/main.mjs`。

`cfg(debug_assertions)` ではなく `tauri::is_dev()` で分けるのは、`tauri build --debug` でも配布と同じ経路を試せるようにするため（今回それで本番経路を検証した）。

すべての経路で `ACC_HOME` を子に明示的に渡す（シェルが読む `daemon.json` とデーモンが書く場所を必ず一致させる）。起動直後のログ（構文エラー等）は `~/.acc/logs/daemon-launch.log` に追記し、起動失敗時はその末尾をエラーに含めて UI に返す。

**開発時の運用**：デーモンを触るときは `pnpm dev:daemon`（tsx watch）を別ターミナルで動かしておけば、UI はそれに接続するだけになる。UI が起動した detach デーモンはソース変更で再読込されないので、古いデーモンが残っていたら CLI（`acc daemon stop` 相当）で止める。将来、`/health` にバージョンを載せ、シェルの期待バージョンと違えば「アイドル時に再起動」する仕組みを入れる（アプリ更新後の古いデーモン対策も兼ねる）。

### 配布形態の比較

| 案 | 評価 |
|---|---|
| **A. 公式 node.exe を externalBin で同梱 ＋ esbuild バンドル（採用）** | 開発と同じランタイムで挙動差が出ない。Agent SDK が子プロセスとして node を起動する場合も同梱 node（`process.execPath`）を渡せる。ネイティブアドオンも node の ABI に合わせた prebuild を resources に置けば動く。インストーラは LZMA で 30MB 前後増える見込み。タスクマネージャーに `acc-node.exe` と出るので、ユーザーにも何が動いているか分かる。 |
| B. Node SEA（単一実行ファイル） | Node 22 の SEA は CommonJS 1 ファイル前提で、ESM のバンドルや資産の扱いに手間がかかる。サイズは node 本体と同程度なので小さくならない。決定的なのは、SEA では `process.execPath` が SEA 自身になり、Agent SDK が `node cli.js` のように子 node を起動する経路が壊れること（結局 node を別に持つ必要が出る）。今は採らない。 |
| C. Bun compile | architecture.md の方針で Bun は保留。 |
| D. ユーザーの Node を使う | インストール手順が増え、バージョン差で壊れる。体験として不可。 |

起動をさらに縮める余地：pre-warm は今 `setup` から始めているが、`run()` の先頭（プラグイン初期化より前）で始めれば debug で約 0.5 秒早くなる（`tauri dev` 経路は `AppHandle` 不要、本番経路は exe からの相対パスで resources を引けば良い）。

要検証として残すこと：Claude Agent SDK が子プロセスに使う実行ファイルの指定方法（`executable` / `pathToClaudeCodeExecutable` 等のオプションで同梱 node と SDK 同梱の CLI を明示する）。SQLite は `node:sqlite`（Node 22 組み込み）ならネイティブアドオンの同梱問題が消えるので、daemon 側の選定時に考慮する。

**更新時の注意**：Windows は実行中の exe を上書きできないので、`acc-node.exe` が動いているとインストーラ／updater が置き換えに失敗する。updater 導入時に「インストール前にデーモンへ `daemon.shutdown` を送る」か NSIS フックで止める処理を入れる。

## 4. ウィンドウとタイトルバー

| 案 | 長所 | 短所 |
|---|---|---|
| ネイティブ枠（`decorations: true`） | 何もしなくて良い。スナップレイアウトのフライアウトも出る | タイトルバーにアプリの UI を置けず、見た目が「普通のアプリ」止まり |
| **枠なし＋HTML タイトルバー（採用）** | タイトルバーにタブ・検索・状態表示を統合でき、Claude Desktop / VS Code 的な一体感が出せる | 最大化ボタンのホバーで出る Win11 スナップレイアウトのフライアウトは出ない（ドラッグでの Aero Snap、Win+矢印、Win+Z、ダブルクリック最大化、Alt+F4 は使える） |
| 枠なし＋`tauri-plugin-decorum` | スナップレイアウトのフライアウトまで再現 | サードパーティ依存。必要になったら差し替えで足せる |

- `shadow: true` で枠なしでも影が付き、Win11 では角丸になる（Win10 では 1px の白い縁が出る）。
- `visible: false` ＋ `backgroundColor`（ダーク基調の色）で起動し、最初のページ読み込み完了（`on_page_load` の `Finished`）で `show()`。WebView2 の白フラッシュが出ない。window-state は `VISIBLE` を除いて復元する（隠したまま復元されないように）。
- ドラッグ領域は `data-tauri-drag-region` を**付けた要素そのもの**に効く。タイトル文字など子要素にも付ける。ボタンには付けない。ダブルクリック最大化には `core:window:allow-internal-toggle-maximize` が要る。
- キャプションボタンは Segoe Fluent Icons のグリフ（最小化 `E921`、最大化 `E922`、元に戻す `E923`、閉じる `E8BB`）を 46px 幅で並べ、閉じるのホバーは `#c42b1c`。これで Windows 標準とほぼ同じ手触りになる。最大化状態は `onResized` を購読して切り替える。
- **Mica / Acrylic**：Tauri 2 は設定の `windowEffects: { "effects": ["mica"] }` ＋ `transparent: true` だけで使える（内部で window-vibrancy を使っており crate 追加は不要）。ただし WebView を透明にすると ClearType が効かず文字がわずかにぼやける、背景を全面透明にする CSS 設計が必要、Win10 では効かない、という代償がある。MVP は不透明の背景で作り、サイドバーだけ Mica にする等は後から検討する。
- HTML5 のドラッグ＆ドロップ：`dragDropEnabled`（既定 true）だと Windows ではネイティブのファイルドロップが優先され、HTML5 DnD が効かない。並べ替え等は pointer ベースのライブラリ（dnd-kit 等）を使い、ファイルのドロップは Tauri のドロップイベントで受ける。
- ウィンドウを閉じたらアプリは終了し、デーモンは残る。トレイ常駐（「バックグラウンドで動作中」表示、デーモン停止メニュー）は後で `tray-icon` 機能で足せる。

## 5. CSP と通信

- `connect-src` に `http://127.0.0.1:* ws://127.0.0.1:*` を足す（`ipc: http://ipc.localhost` は Tauri の IPC 用）。WebView2 からループバックへの WS / fetch は問題なく通った（Origin は `http://tauri.localhost`）。
- UI はデーモンと直接 WS で話す（IPC 経由のプロキシはしない）。ブラウザモード（`pnpm dev`）と同じ経路になり、E2E をブラウザで回せるため。HTTP エンドポイントを UI から叩くなら、デーモンは許可リストの Origin にだけ `Access-Control-Allow-Origin` を返す。
- デーモン再起動でトークンが変わるので、UI は WS が切れたら `getConnection()` を呼び直してから再接続する（`get_connection` は生存中なら数 ms で返る冪等な呼び出し）。

## 6. 検証したこと

プロトタイプ：`<scratchpad>/tauri-probe`（リポジトリ外）。偽デーモン `fake-daemon/main.mjs` は契約どおり bind → `daemon.json` を原子的に書く → `/health` → `/ws?token=`（トークンと Origin を検査）を実装。

- `cargo test`：stale な `daemon.json` を拒否する／起動直後にクラッシュしたら stderr の末尾付きでエラーになる／初回は spawn し 2 回目は再利用（同じ pid）／競合した 2 つ目のデーモンは exit 0 で `daemon.json` を上書きしない、の 3 テストが通過。
- 実アプリ（`tauri build --debug --no-bundle` の exe、本番経路＝同梱 node＋resources）：
  - 起動 → pre-warm でデーモン起動 → フロントの `get_connection` が 204〜215ms で返る → 2 回目は 5ms・同じ pid → WS 接続成功（Origin `http://tauri.localhost`）→ `is_maximized` 取得 → `close` でアプリ終了（exit 0）。
  - アプリ終了後もデーモンは生存、別コマンドから見ても生存。
  - アプリを `Stop-Process -Force` で強制終了してもデーモンは生存し `/health` に応答。
  - アプリ起動中に 2 つ目を起動すると約 1 秒で exit 0（single-instance が既存ウィンドウを前面化）。
  - 標準ハンドル継承の修正後、`acc-desktop.exe | ...` のパイプは UI 終了と同時に閉じる。

未検証：`tauri dev`（Vite 経由）での実行、NSIS バンドル（初回に NSIS ツールのダウンロードが走る）、Mica、decorum、高 DPI・複数モニタでの window-state 復元。

## 7. そのまま置けるファイル一式（`apps/desktop/`）

モノレポ内の配置：

```
apps/desktop/
  package.json            # @acc/desktop
  vite.config.ts
  index.html, src/...     # React（connection.ts / TitleBar.tsx は下に例）
  scripts/prepare-sidecar.mjs
  src-tauri/
    Cargo.toml  Cargo.lock  build.rs  tauri.conf.json
    capabilities/default.json
    icons/                # `pnpm tauri icon <1024px png>` で生成
    src/main.rs  src/lib.rs  src/daemon.rs
    binaries/             # .gitignore（acc-node-<target-triple>.exe）
    resources/daemon/     # .gitignore（daemon の esbuild バンドル main.mjs）
```

`.gitignore` に追加：`apps/desktop/src-tauri/target/`、`apps/desktop/src-tauri/gen/`（schemas は再生成される）、`apps/desktop/src-tauri/binaries/`、`apps/desktop/src-tauri/resources/daemon/`。

プロトタイプとの差分は `tauri.conf.json` の `build.beforeDevCommand` / `beforeBuildCommand`（プロトタイプは静的 HTML だったので空）だけ。

### src-tauri/Cargo.toml

```toml
[package]
name = "acc-desktop"
version = "0.1.0"
description = "AI Agent Command Center desktop shell"
edition = "2021"
rust-version = "1.89"
# MSRV-aware resolution: pick the newest deps that still build on rust-version
resolver = "3"
publish = false

[lib]
# desktop only: rlib is enough (staticlib/cdylib are for mobile targets)
name = "acc_desktop_lib"
crate-type = ["rlib"]

[build-dependencies]
tauri-build = { version = "2", features = [] }

[dependencies]
tauri = { version = "2", features = [] }
tauri-plugin-opener = "2"
tauri-plugin-window-state = "2"
serde = { version = "1", features = ["derive"] }
serde_json = "1"

[target.'cfg(any(target_os = "macos", windows, target_os = "linux"))'.dependencies]
tauri-plugin-single-instance = "2"

[profile.release]
codegen-units = 1
lto = true
opt-level = "s"
panic = "abort"
strip = true
```

### src-tauri/build.rs

```rust
fn main() {
    tauri_build::build()
}
```

### src-tauri/tauri.conf.json

```json
{
  "$schema": "https://schema.tauri.app/config/2",
  "productName": "AI Agent Command Center",
  "mainBinaryName": "acc-desktop",
  "version": "0.1.0",
  "identifier": "com.acc.desktop",
  "build": {
    "frontendDist": "../dist",
    "devUrl": "http://localhost:5173",
    "beforeDevCommand": "pnpm dev",
    "beforeBuildCommand": "pnpm build"
  },
  "app": {
    "withGlobalTauri": false,
    "windows": [
      {
        "label": "main",
        "title": "AI Agent Command Center",
        "width": 1280,
        "height": 820,
        "minWidth": 880,
        "minHeight": 560,
        "center": true,
        "decorations": false,
        "shadow": true,
        "visible": false,
        "backgroundColor": "#0e0f13",
        "useHttpsScheme": false
      }
    ],
    "security": {
      "csp": {
        "default-src": "'self'",
        "connect-src": "'self' ipc: http://ipc.localhost http://127.0.0.1:* ws://127.0.0.1:*",
        "script-src": "'self'",
        "style-src": "'self' 'unsafe-inline'",
        "img-src": "'self' data: blob:",
        "font-src": "'self' data:"
      }
    }
  },
  "bundle": {
    "active": true,
    "targets": [
      "nsis"
    ],
    "icon": [
      "icons/icon.ico",
      "icons/icon.png"
    ],
    "externalBin": [
      "binaries/acc-node"
    ],
    "resources": {
      "resources/daemon/": "daemon/"
    },
    "windows": {
      "nsis": {
        "installMode": "currentUser"
      }
    }
  }
}
```

### src-tauri/capabilities/default.json

```json
{
  "$schema": "../gen/schemas/desktop-schema.json",
  "identifier": "default",
  "description": "Main window: custom title bar + window state + opening links",
  "windows": ["main"],
  "permissions": [
    "core:default",
    "core:window:allow-start-dragging",
    "core:window:allow-internal-toggle-maximize",
    "core:window:allow-minimize",
    "core:window:allow-toggle-maximize",
    "core:window:allow-close",
    "core:window:allow-show",
    "core:window:allow-set-focus",
    "window-state:default",
    "opener:default"
  ]
}
```

アプリ独自のコマンド（`get_connection`）は、app manifest を定義しない限り全ウィンドウから呼べるので capability への記載は不要。`core:default` に `is_maximized` 等の読み取り系が含まれる。

### src-tauri/src/main.rs

```rust
// Prevents an additional console window on Windows in release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    acc_desktop_lib::run()
}
```

### src-tauri/src/lib.rs

```rust
mod daemon;

use std::path::PathBuf;
use std::sync::Mutex;
use std::time::Duration;
use tauri::{AppHandle, Manager};
use tauri_plugin_window_state::StateFlags;

/// Serializes ensure() inside this process (StrictMode double invoke, pre-warm vs first call).
static ENSURE_LOCK: Mutex<()> = Mutex::new(());
const STARTUP_TIMEOUT: Duration = Duration::from_secs(20);

/// Resolve how to start the daemon.
/// 1. ACC_DAEMON_ENTRY=<file>  : `node <file>` (`--import tsx` for .ts). Escape hatch for dev/tests.
/// 2. `tauri dev`              : node + tsx on the repo source (packages/daemon/src/main.ts).
/// 3. built app                : bundled node (externalBin "acc-node") + resources/daemon/main.mjs.
fn launch_spec(app: &AppHandle) -> Result<daemon::LaunchSpec, String> {
    let node_from_path = || PathBuf::from(std::env::var_os("ACC_NODE").unwrap_or_else(|| "node".into()));

    if let Some(entry) = std::env::var_os("ACC_DAEMON_ENTRY").filter(|v| !v.is_empty()) {
        let entry = PathBuf::from(entry);
        let mut args = Vec::new();
        if entry.extension().is_some_and(|e| e == "ts") {
            args.push("--import".into());
            args.push("tsx".into());
        }
        args.push(entry.clone().into_os_string());
        return Ok(daemon::LaunchSpec { program: node_from_path(), args, cwd: entry.parent().map(Into::into) });
    }

    if tauri::is_dev() {
        // apps/desktop/src-tauri -> repo root. Compile-time path, only used under `tauri dev`.
        let pkg = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../packages/daemon");
        return Ok(daemon::LaunchSpec {
            program: node_from_path(),
            // cwd = packages/daemon so `--import tsx` resolves from its node_modules
            args: vec!["--import".into(), "tsx".into(), "src/main.ts".into()],
            cwd: Some(pkg),
        });
    }

    let exe_dir = std::env::current_exe()
        .map_err(|e| e.to_string())?
        .parent()
        .ok_or("no exe dir")?
        .to_path_buf();
    let node = exe_dir.join(if cfg!(windows) { "acc-node.exe" } else { "acc-node" });
    let entry = app
        .path()
        .resource_dir()
        .map_err(|e| e.to_string())?
        .join("daemon")
        .join("main.mjs");
    if !entry.exists() {
        return Err(format!("daemon bundle not found: {}", entry.display()));
    }
    Ok(daemon::LaunchSpec { program: node, args: vec![entry.into_os_string()], cwd: None })
}

fn ensure_blocking(app: &AppHandle) -> Result<daemon::Connection, String> {
    let _g = ENSURE_LOCK.lock().unwrap_or_else(|p| p.into_inner());
    daemon::ensure(&daemon::acc_home(), || launch_spec(app), STARTUP_TIMEOUT)
}

/// Frontend entry point. Idempotent and cheap when the daemon is already up, so the UI
/// can call it again whenever the WebSocket drops (daemon restart = new token).
/// `async` + spawn_blocking: a sync command would run on the main thread and freeze the window.
#[tauri::command]
async fn get_connection(app: AppHandle) -> Result<daemon::Connection, String> {
    tauri::async_runtime::spawn_blocking(move || ensure_blocking(&app))
        .await
        .map_err(|e| e.to_string())?
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // must be the first plugin: a second launch focuses the existing window and exits
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.unminimize();
                let _ = w.show();
                let _ = w.set_focus();
            }
        }))
        .plugin(
            tauri_plugin_window_state::Builder::new()
                // window starts hidden (no white flash); we decide when to show it
                .with_state_flags(StateFlags::all() & !StateFlags::VISIBLE)
                .build(),
        )
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![get_connection])
        .setup(|app| {
            // Pre-warm: start the daemon while the WebView boots, so the first
            // get_connection() usually returns immediately.
            let handle = app.handle().clone();
            tauri::async_runtime::spawn_blocking(move || {
                if let Err(e) = ensure_blocking(&handle) {
                    eprintln!("[acc] daemon pre-warm failed: {e}");
                }
            });
            Ok(())
        })
        .on_page_load(|webview, payload| {
            // Show once the first document has loaded (backgroundColor + visible:false
            // in tauri.conf.json avoid the white WebView2 flash).
            if payload.event() == tauri::webview::PageLoadEvent::Finished {
                let _ = webview.window().show();
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
```

### src-tauri/src/daemon.rs

テストの `ensure_spawns_once_then_reuses_and_survives_race` は偽デーモン（`../fake-daemon/main.mjs`）を前提にしている。リポジトリでは `src-tauri/tests/fixtures/fake-daemon.mjs` 等に置いてパスを直すか、本物のデーモンができたら差し替える（`taskkill` を使うので Windows 前提。他 OS 対応時に `cfg` で分ける）。

```rust
//! Core Daemon discovery / launch. Pure std (no Tauri types) so it can be unit tested.
//!
//! Contract (docs/persistent/architecture.md §2.1):
//!   <ACC_HOME>/daemon.json = { port, token, pid }, GET http://127.0.0.1:<port>/health
//!   -> { ok: true, service: "acc-daemon", pid, ... }
//! The shell never owns the daemon: it is spawned detached and outlives the UI.

use serde::{Deserialize, Serialize};
use std::ffi::OsString;
use std::fs::{self, OpenOptions};
use std::io::{Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

#[derive(Debug, Clone, Deserialize)]
pub struct DaemonInfo {
    pub port: u16,
    pub token: String,
    pub pid: u32,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Connection {
    /// e.g. http://127.0.0.1:47821
    pub url: String,
    /// e.g. ws://127.0.0.1:47821/ws (token is passed separately; the client appends ?token=)
    pub ws_url: String,
    pub token: String,
    pub pid: u32,
    /// true when this call had to start the daemon
    pub spawned: bool,
}

/// How to start the daemon. Built by the Tauri side (dev vs bundled).
#[derive(Debug, Clone)]
pub struct LaunchSpec {
    pub program: PathBuf,
    pub args: Vec<OsString>,
    pub cwd: Option<PathBuf>,
}

pub fn acc_home() -> PathBuf {
    if let Some(h) = std::env::var_os("ACC_HOME").filter(|v| !v.is_empty()) {
        return PathBuf::from(h);
    }
    #[allow(deprecated)] // un-deprecated in Rust 1.86+, kept for older toolchains
    let home = std::env::home_dir().unwrap_or_else(|| PathBuf::from("."));
    home.join(".acc")
}

pub fn read_info(home: &Path) -> Option<DaemonInfo> {
    let raw = fs::read(home.join("daemon.json")).ok()?;
    serde_json::from_slice(&raw).ok()
}

/// Minimal HTTP/1.1 GET /health over std TcpStream (avoids an HTTP client crate).
/// Returns true only if the responder identifies as our daemon with the expected pid,
/// so a stale daemon.json pointing at a port reused by another program is rejected.
pub fn health(port: u16, expected_pid: u32) -> bool {
    let addr = SocketAddr::from(([127, 0, 0, 1], port));
    let Ok(mut s) = TcpStream::connect_timeout(&addr, Duration::from_millis(300)) else {
        return false;
    };
    let _ = s.set_read_timeout(Some(Duration::from_millis(800)));
    let _ = s.set_write_timeout(Some(Duration::from_millis(300)));
    // HTTP/1.0: Node answers 1.0 requests without chunked transfer-encoding
    let req = format!("GET /health HTTP/1.0\r\nHost: 127.0.0.1:{port}\r\n\r\n");
    if s.write_all(req.as_bytes()).is_err() {
        return false;
    }
    let mut buf = Vec::with_capacity(512);
    let _ = s.take(16 * 1024).read_to_end(&mut buf);
    let text = String::from_utf8_lossy(&buf);
    if !text.starts_with("HTTP/1.1 200") && !text.starts_with("HTTP/1.0 200") {
        return false;
    }
    // tolerate chunked framing anyway: parse the outermost JSON object of the body
    let Some((_, body)) = text.split_once("\r\n\r\n") else { return false };
    let (Some(a), Some(b)) = (body.find('{'), body.rfind('}')) else { return false };
    let Ok(v) = serde_json::from_str::<serde_json::Value>(&body[a..=b]) else { return false };
    v["service"] == "acc-daemon" && v["pid"].as_u64() == Some(expected_pid as u64)
}

/// Connection to an already-running daemon, if any.
pub fn probe(home: &Path) -> Option<Connection> {
    let info = read_info(home)?;
    health(info.port, info.pid).then(|| to_conn(info, false))
}

fn to_conn(info: DaemonInfo, spawned: bool) -> Connection {
    Connection {
        url: format!("http://127.0.0.1:{}", info.port),
        ws_url: format!("ws://127.0.0.1:{}/ws", info.port),
        token: info.token,
        pid: info.pid,
        spawned,
    }
}

/// Return a live connection, starting the daemon if needed.
/// Callers must serialize calls (see the Mutex in lib.rs) so a double invoke
/// (React StrictMode, pre-warm + first render) does not spawn twice. Cross-process
/// races (UI vs CLI) are resolved by the daemon itself: the loser fails to bind and exits 0.
pub fn ensure(home: &Path, spec: impl FnOnce() -> Result<LaunchSpec, String>, timeout: Duration) -> Result<Connection, String> {
    if let Some(c) = probe(home) {
        return Ok(c);
    }
    let spec = spec()?;
    fs::create_dir_all(home.join("logs")).map_err(|e| format!("cannot create {}: {e}", home.display()))?;
    let log_path = home.join("logs").join("daemon-launch.log");
    let mut child = spawn_detached(&spec, home, &log_path)?;

    let deadline = Instant::now() + timeout;
    let mut child_exited_ok = false;
    loop {
        if let Some(info) = read_info(home) {
            if health(info.port, info.pid) {
                return Ok(to_conn(info, true));
            }
        }
        if !child_exited_ok {
            match child.try_wait() {
                // exit 0 = lost the race to another daemon; keep polling for the winner
                Ok(Some(st)) if st.success() => child_exited_ok = true,
                Ok(Some(st)) => {
                    return Err(format!(
                        "Core Daemon exited during startup ({st}).\n{}",
                        tail(&log_path, 2000)
                    ))
                }
                _ => {}
            }
        }
        if Instant::now() >= deadline {
            return Err(format!("Core Daemon did not become healthy within {timeout:?}.\n{}", tail(&log_path, 2000)));
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    // NOTE: dropping `child` does NOT kill the process on any platform.
}

fn spawn_detached(spec: &LaunchSpec, home: &Path, log_path: &Path) -> Result<Child, String> {
    let open_log = || OpenOptions::new().create(true).append(true).open(log_path);
    let mut cmd = Command::new(&spec.program);
    // the daemon must use the same home the shell resolved (and will read daemon.json from)
    cmd.env("ACC_HOME", home);
    cmd.args(&spec.args)
        .stdin(Stdio::null())
        .stdout(open_log().map_err(|e| e.to_string())?)
        .stderr(open_log().map_err(|e| e.to_string())?);
    if let Some(cwd) = &spec.cwd {
        cmd.current_dir(cwd);
    }

    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // CREATE_NO_WINDOW: the daemon gets a *hidden* console. Children it spawns
        //   (git, claude, shells) inherit it, so no console windows flash.
        //   (DETACHED_PROCESS would leave it with *no* console and every console child
        //   would pop its own window unless windowsHide is set on every spawn.)
        // CREATE_NEW_PROCESS_GROUP: Ctrl+C in the `tauri dev` terminal does not reach it.
        // CREATE_BREAKAWAY_FROM_JOB: escape a kill-on-close job (some terminals / IDE
        //   runners / CI put children in one). Fails with ERROR_ACCESS_DENIED if the job
        //   forbids breakaway, so retry without it.
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
        const CREATE_BREAKAWAY_FROM_JOB: u32 = 0x0100_0000;
        let base = CREATE_NO_WINDOW | CREATE_NEW_PROCESS_GROUP;
        // std::process spawns with bInheritHandles=TRUE, so the daemon would also inherit
        // OUR std handles when they are inheritable (e.g. the pipe `tauri dev`/a terminal
        // gave us). The long-lived daemon would then hold that pipe open forever and the
        // reader never sees EOF (verified: `acc-desktop.exe | cat` hung after the UI exited).
        clear_std_handle_inheritance();
        cmd.creation_flags(base | CREATE_BREAKAWAY_FROM_JOB);
        match cmd.spawn() {
            Ok(c) => return Ok(c),
            Err(e) if e.raw_os_error() == Some(5) => {
                eprintln!("[acc] CREATE_BREAKAWAY_FROM_JOB denied; spawning inside the current job");
                cmd.creation_flags(base);
                // reopen the log handles defensively for the second attempt
                cmd.stdout(open_log().map_err(|e| e.to_string())?)
                    .stderr(open_log().map_err(|e| e.to_string())?);
            }
            Err(e) => return Err(format!("failed to start {}: {e}", spec.program.display())),
        }
    }
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        cmd.process_group(0); // detach from the terminal's process group (no SIGINT/SIGHUP fan-out)
    }
    cmd.spawn().map_err(|e| format!("failed to start {}: {e}", spec.program.display()))
}

#[cfg(windows)]
fn clear_std_handle_inheritance() {
    type Handle = *mut core::ffi::c_void;
    #[link(name = "kernel32")]
    extern "system" {
        fn GetStdHandle(n: u32) -> Handle;
        fn SetHandleInformation(h: Handle, mask: u32, flags: u32) -> i32;
    }
    const STD_HANDLES: [u32; 3] = [-10i32 as u32, -11i32 as u32, -12i32 as u32];
    const HANDLE_FLAG_INHERIT: u32 = 0x1;
    for n in STD_HANDLES {
        // SAFETY: plain Win32 calls on our own std handles; null/INVALID are skipped.
        unsafe {
            let h = GetStdHandle(n);
            if !h.is_null() && h as isize != -1 {
                SetHandleInformation(h, HANDLE_FLAG_INHERIT, 0);
            }
        }
    }
}

fn tail(path: &Path, max: usize) -> String {
    let s = fs::read_to_string(path).unwrap_or_default();
    let start = s.len().saturating_sub(max);
    let start = (start..s.len()).find(|i| s.is_char_boundary(*i)).unwrap_or(s.len());
    s[start..].to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp_home(name: &str) -> PathBuf {
        let p = std::env::temp_dir().join(format!("acc-probe-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&p);
        fs::create_dir_all(&p).unwrap();
        p
    }

    #[test]
    fn probe_rejects_missing_and_stale_info() {
        let home = tmp_home("stale");
        assert!(probe(&home).is_none());
        // stale file pointing to a port nobody listens on
        fs::write(home.join("daemon.json"), r#"{"port":1,"token":"x","pid":42}"#).unwrap();
        assert!(probe(&home).is_none());
    }

    /// Uses the fake daemon (../fake-daemon/main.mjs) on a test-only port.
    #[test]
    fn ensure_spawns_once_then_reuses_and_survives_race() {
        let home = tmp_home("spawn");
        let entry = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../fake-daemon/main.mjs");
        std::env::set_var("ACC_PORT", "47898"); // inherited by the child; only this test sets it
        let spec = || Ok(LaunchSpec { program: "node".into(), args: vec![entry.clone().into()], cwd: None });
        let first = ensure(&home, spec, Duration::from_secs(10)).unwrap();
        assert!(first.spawned);
        let second = ensure(&home, spec, Duration::from_secs(10)).unwrap();
        assert!(!second.spawned);
        assert_eq!(first.pid, second.pid);
        // a racing second daemon must exit 0 and must not clobber daemon.json
        let st = Command::new("node").arg(&entry).env("ACC_HOME", &home).status().unwrap();
        assert!(st.success());
        assert_eq!(read_info(&home).unwrap().pid, first.pid);
        let _ = Command::new("taskkill").args(["/F", "/PID", &first.pid.to_string()]).status();
    }

    #[test]
    fn ensure_reports_startup_crash_with_log_tail() {
        let home = tmp_home("crash");
        let spec = || {
            Ok(LaunchSpec {
                program: PathBuf::from("node"),
                args: vec!["-e".into(), "console.error('boom-from-daemon'); process.exit(3)".into()],
                cwd: None,
            })
        };
        let err = ensure(&home, spec, Duration::from_secs(5)).unwrap_err();
        assert!(err.contains("boom-from-daemon"), "{err}");
    }
}
```

### 偽デーモン（テスト用 fixture）

```js
// Fake Core Daemon for the Tauri shell probe. Mimics the contract in
// docs/persistent/architecture.md §2.1: bind 127.0.0.1:<ACC_PORT>, write
// <ACC_HOME>/daemon.json atomically AFTER listen succeeds, serve GET /health,
// accept WS upgrade on /ws?token=... with Origin allowlist.
import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const home = process.env.ACC_HOME || path.join(os.homedir(), ".acc");
const port = Number(process.env.ACC_PORT || 47821);
const token = crypto.randomBytes(24).toString("base64url");
fs.mkdirSync(path.join(home, "logs"), { recursive: true });
const logFile = path.join(home, "logs", "fake-daemon.log");
const log = (...a) =>
  fs.appendFileSync(logFile, `${new Date().toISOString()} [pid ${process.pid}] ${a.join(" ")}\n`);

const ALLOWED_ORIGINS = new Set([
  "http://tauri.localhost", // Tauri 2 on Windows (useHttpsScheme=false)
  "https://tauri.localhost", // Windows with useHttpsScheme=true
  "tauri://localhost", // macOS / Linux
  "http://localhost:5173", // vite dev
]);

const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://127.0.0.1");
  if (url.pathname === "/health") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, service: "acc-daemon", pid: process.pid, version: "0.0.0-probe" }));
    return;
  }
  if (url.pathname === "/report") {
    log("REPORT", url.searchParams.get("msg") ?? "", "origin=" + (req.headers.origin ?? "-"));
    res.writeHead(204, { "access-control-allow-origin": req.headers.origin ?? "*" });
    res.end();
    return;
  }
  res.writeHead(404).end();
});

server.on("upgrade", (req, socket) => {
  const url = new URL(req.url, "http://127.0.0.1");
  const origin = req.headers.origin;
  if (url.pathname !== "/ws" || url.searchParams.get("token") !== token || (origin && !ALLOWED_ORIGINS.has(origin))) {
    log("WS REJECT origin=" + origin);
    socket.end("HTTP/1.1 403 Forbidden\r\n\r\n");
    return;
  }
  const accept = crypto
    .createHash("sha1")
    .update(req.headers["sec-websocket-key"] + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11")
    .digest("base64");
  socket.write(
    "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n" +
      `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
  );
  log("WS OPEN origin=" + origin);
});

server.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    // Lost the start race (UI and CLI spawned at the same time) or already running.
    log("port in use; another daemon owns it. exiting 0");
    process.exit(0);
  }
  log("server error", String(err));
  process.exit(1);
});

server.listen(port, "127.0.0.1", () => {
  const info = JSON.stringify({ port, token, pid: process.pid });
  const tmp = path.join(home, `daemon.json.${process.pid}.tmp`);
  fs.writeFileSync(tmp, info, { mode: 0o600 });
  fs.renameSync(tmp, path.join(home, "daemon.json")); // atomic replace
  log(`listening on ${port}; argv=${JSON.stringify(process.argv.slice(1))}; execPath=${path.basename(process.execPath)}`);
  if (process.env.ACC_PROBE_STARTUP_DELAY) log("(startup delay was applied)");
});

for (const sig of ["SIGINT", "SIGTERM", "SIGBREAK"]) {
  process.on(sig, () => {
    log("got " + sig);
    process.exit(0);
  });
}
```

### package.json（apps/desktop）

```json
{
  "name": "@acc/desktop",
  "private": true,
  "version": "0.1.0",
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "tsc -b && vite build",
    "tauri": "tauri",
    "tauri:dev": "node scripts/prepare-sidecar.mjs && tauri dev",
    "tauri:build": "node scripts/prepare-sidecar.mjs --release && tauri build"
  },
  "dependencies": {
    "@tauri-apps/api": "^2.11.1",
    "@tauri-apps/plugin-opener": "~2.5.5",
    "@tauri-apps/plugin-window-state": "~2.4.1",
    "@types/node": "^22.20.5",
    "@types/react": "^19.3.0",
    "react": "^19.3.1",
    "react-dom": "^19.3.1"
  },
  "devDependencies": {
    "@tauri-apps/cli": "^2.12.4",
    "@vitejs/plugin-react": "^5.2.0",
    "typescript": "^5.9.3",
    "vite": "^7.3.7"
  }
}
```

### vite.config.ts

```ts
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

// Browser mode (`pnpm dev` without Tauri): hand daemon.json to the page, like get_connection does.
// Only the dev server has this endpoint; production builds never expose the token over HTTP.
function accConnection(): Plugin {
  return {
    name: "acc-connection",
    configureServer(server) {
      server.middlewares.use("/__acc/connection", async (_req, res) => {
        try {
          const home = process.env.ACC_HOME || join(homedir(), ".acc");
          const info = JSON.parse(await readFile(join(home, "daemon.json"), "utf8"));
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify({
            url: `http://127.0.0.1:${info.port}`,
            wsUrl: `ws://127.0.0.1:${info.port}/ws`,
            token: info.token,
            pid: info.pid,
            spawned: false,
          }));
        } catch {
          res.statusCode = 503;
          res.end(JSON.stringify({ error: "daemon_not_running" }));
        }
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), accConnection()],
  clearScreen: false, // keep Rust errors visible under `tauri dev`
  server: { port: 5173, strictPort: true, host: "127.0.0.1" },
  envPrefix: ["VITE_", "TAURI_ENV_"],
  build: {
    target: "chrome120", // WebView2 is evergreen Chromium
    sourcemap: !!process.env.TAURI_ENV_DEBUG,
  },
});
```

### scripts/prepare-sidecar.mjs

```js
// apps/desktop/scripts/prepare-sidecar.mjs
// Puts the Node runtime where tauri.conf.json `bundle.externalBin` expects it.
// tauri-build fails (even for `cargo check` / `tauri dev`) when the file is missing.
//   dev     : copy the Node that runs this script (fast, offline)
//   --release: TODO download a pinned official Node build + verify SHASUMS256 (CI)
import { copyFileSync, existsSync, mkdirSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "src-tauri");
const triple = execFileSync("rustc", ["--print", "host-tuple"], { encoding: "utf8" }).trim();
const ext = process.platform === "win32" ? ".exe" : "";
const dest = join(root, "binaries", `acc-node-${triple}${ext}`);
mkdirSync(dirname(dest), { recursive: true });
if (process.argv.includes("--release")) {
  throw new Error("release: download pinned Node and verify checksum (not implemented yet)");
}
if (!existsSync(dest) || statSync(dest).size !== statSync(process.execPath).size) {
  copyFileSync(process.execPath, dest);
  console.log(`sidecar: ${process.execPath} -> ${dest}`);
}
// resources/daemon must also exist for tauri-build; the real bundle comes from the daemon package
mkdirSync(join(root, "resources", "daemon"), { recursive: true });
```

### src/connection.ts

```ts
import { invoke, isTauri } from "@tauri-apps/api/core";

export type Connection = { url: string; wsUrl: string; token: string; pid: number; spawned: boolean };

/** Tauri: Rust starts the daemon if needed. Browser: Vite dev middleware reads daemon.json. */
export async function getConnection(): Promise<Connection> {
  if (isTauri()) return invoke<Connection>("get_connection");
  const res = await fetch("/__acc/connection");
  if (!res.ok) throw new Error("Core Daemon が起動していません（`pnpm dev:daemon` で起動してください）");
  return res.json();
}
```

### src/TitleBar.tsx と CSS

```tsx
import { useEffect, useState, type ReactNode } from "react";
import { isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";

// Segoe Fluent Icons (Win11) / MDL2 (Win10) glyphs
const GLYPH = { min: "", max: "", restore: "", close: "" };

export function TitleBar({ children }: { children?: ReactNode }) {
  const [maximized, setMaximized] = useState(false);

  // useEffect is required here: subscribing to the native window's resize events
  // (an external system) to mirror the maximized state in the caption button.
  useEffect(() => {
    if (!isTauri()) return;
    const w = getCurrentWindow();
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void w.isMaximized().then((m) => !disposed && setMaximized(m));
    void w
      .onResized(() => void w.isMaximized().then((m) => !disposed && setMaximized(m)))
      .then((u) => (disposed ? u() : (unlisten = u)));
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  if (!isTauri()) return null; // browser mode: the browser chrome is the title bar
  const w = getCurrentWindow();
  return (
    // data-tauri-drag-region: drag to move, double-click to maximize (Aero Snap by dragging works)
    <header className="titlebar" data-tauri-drag-region>
      <div className="titlebar-content" data-tauri-drag-region>{children}</div>
      <div className="caption" role="group" aria-label="ウィンドウ操作">
        <button aria-label="最小化" onClick={() => void w.minimize()}>{GLYPH.min}</button>
        <button aria-label={maximized ? "元に戻す" : "最大化"} onClick={() => void w.toggleMaximize()}>
          {maximized ? GLYPH.restore : GLYPH.max}
        </button>
        <button className="close" aria-label="閉じる" onClick={() => void w.close()}>{GLYPH.close}</button>
      </div>
    </header>
  );
}
```

```css
.titlebar { height: 36px; display: flex; align-items: stretch; user-select: none; -webkit-user-select: none; }
.titlebar-content { flex: 1; display: flex; align-items: center; gap: 8px; padding-left: 12px; min-width: 0; }
.caption { display: flex; }
.caption button {
  width: 46px; border: 0; background: transparent; color: inherit;
  font: 10px "Segoe Fluent Icons", "Segoe MDL2 Assets", sans-serif;
  transition: background-color 80ms linear;
}
.caption button:hover { background: color-mix(in srgb, currentColor 10%, transparent); }
.caption button:active { background: color-mix(in srgb, currentColor 6%, transparent); }
.caption button.close:hover { background: #c42b1c; color: #fff; }
```

## 8. 次にやること

1. 上のファイルで `apps/desktop` を作り、`pnpm tauri:dev` で本物の daemon（`packages/daemon/src/main.ts`）に繋ぐ。daemon 側は「bind 失敗で exit 0」「`daemon.json` の原子的書き込み」「`/health` に `service` と `pid`（＋将来 `version`）」「Origin 許可リスト」を実装する。
2. daemon を esbuild で `resources/daemon/main.mjs` に出すスクリプトと、release 用の node 取得（公式配布＋SHASUMS256 検証）を `prepare-sidecar.mjs` に実装する。
3. `tauri build`（NSIS）で実インストールして、インストール先からの起動・更新時のデーモン停止を確認する。
