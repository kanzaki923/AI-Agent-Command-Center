import type { PermissionProfile, Project } from '@acc/protocol';
import { Folder, FolderGit2, GitBranch, TestTube2, TriangleAlert } from 'lucide-react';
import { type ReactNode, useRef, useState } from 'react';
import {
  createProject,
  inspectFolder,
  inspectRepo,
  updateProject,
} from '../../daemon/orchestration';
import { useProjects, useSettings } from '../../daemon/queries';
import { DEFAULT_PROFILE } from '../../model/permissions';
import { HardRulesNote, ProfilePicker, RememberedRules } from '../permissions/Permissions';
import {
  type FolderInspection,
  type ProjectKind,
  type RepoInspection,
  branchText,
  dirtyText,
  projectKindOf,
} from '../../model/repo';
import { useRuntime } from '../../daemon/runtime';
import { toast } from '../../store/toast';
import { useUi } from '../../store/ui';
import { Button } from '../ui/Button';
import { Dialog, FieldLabel, inputClass } from '../ui/Dialog';

const NONE: never[] = [];

/** Folder name of a path (`C:\work\my-repo` → `my-repo`), for the default project name. */
export function folderName(path: string): string {
  return path.trim().split(/[\\/]/).filter(Boolean).pop() ?? '';
}

function Hint({ children }: { children: ReactNode }) {
  return <p className="mt-1 text-meta text-fg-3">{children}</p>;
}

/** What the folder becomes, with one short line after it. */
function KindLine({ kind, children }: { kind: ProjectKind; children: ReactNode }) {
  const Icon = kind === 'code' ? FolderGit2 : Folder;
  return (
    <p
      className="mt-1 flex flex-wrap items-center gap-x-2 text-meta text-fg-3"
      data-project-kind={kind}
    >
      <span className="flex items-center gap-1 text-fg-2">
        <Icon size={12} strokeWidth={2} />
        {kind === 'code' ? 'コード' : 'フォルダ'}
      </span>
      {children}
    </p>
  );
}

interface FolderCheck {
  path: string;
  pending: boolean;
  folder: FolderInspection | null;
  /** Branches and uncommitted changes, for the root of a repository only. */
  repo: RepoInspection | null;
}

/**
 * Add a local folder as a project. The root of a git repository becomes code (agents work in
 * their own worktree, the checkout stays as it is until a change is reflected); any other
 * folder becomes a folder project (agents write in it directly). The daemon looks at the
 * folder while it is typed, so what it will become is shown before anything is created.
 */
export function NewProjectForm({
  onDone,
  compact = false,
}: {
  onDone: (p: Project | null) => void;
  compact?: boolean;
}) {
  const rt = useRuntime();
  const projects = useProjects().data ?? NONE;
  const [path, setPath] = useState('');
  const [name, setName] = useState('');
  // The test command and whether the person typed it (a detected one never overwrites theirs).
  const [test, setTest] = useState({ value: '', touched: false });
  const testCommand = test.value;
  const [branch, setBranch] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [check, setCheck] = useState<FolderCheck | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const current = check && check.path === path.trim() && !check.pending ? check : null;
  const folder = current?.folder ?? null;
  const repo = current?.repo ?? null;
  const checking = !!check?.pending && check.path === path.trim();
  // Unknown (the check could not run) is treated as code, as before folders could be added;
  // a folder that cannot be used shows no code fields.
  const kind: ProjectKind = folder ? (folder.ok ? projectKindOf(folder) : 'folder') : 'code';
  const derived = name.trim() || folder?.suggestedName || folderName(path);
  const rootHint = folder?.ok && kind === 'folder' && folder.repoRoot ? folder.repoRoot : null;
  const existing = folder?.existingProjectId
    ? (projects.find((p) => p.id === folder.existingProjectId) ?? null)
    : null;
  const detectedBranch = repo?.defaultBranch || folder?.defaultBranch || '';
  const defaultBranch = branch.trim() || detectedBranch;

  /** Look at the folder while typing (debounced), before anything is created. */
  const inspect = (value: string, delay: number) => {
    if (timer.current) clearTimeout(timer.current);
    const p = value.trim();
    if (!p) {
      setCheck(null);
      return;
    }
    setCheck({ path: p, pending: true, folder: null, repo: null });
    timer.current = setTimeout(() => {
      void (async () => {
        const f = await inspectFolder(rt, p);
        const isCode = !!f?.ok && projectKindOf(f) === 'code';
        const r = isCode ? await inspectRepo(rt, p) : null;
        setCheck((cur) =>
          cur?.path === p ? { path: p, pending: false, folder: f, repo: r } : cur,
        );
        // Prefill what this folder tells, replacing what an earlier path filled in (never what
        // the person typed).
        const detected = (isCode ? f?.suggestedTestCommand : null) ?? '';
        setTest((cur) => (cur.touched ? cur : { value: detected, touched: false }));
      })();
    }, delay);
  };

  const adoptPath = (value: string) => {
    setPath(value);
    setError(null);
    inspect(value, 0);
  };

  // Not a usable folder, or already a project: nothing to create (the daemon would accept a
  // duplicate; the form points at the existing project instead).
  const blocked = !!folder && (!folder.ok || !!folder.existingProjectId);

  const submit = async () => {
    if (!path.trim() || busy || blocked) return;
    setBusy(true);
    setError(null);
    const where = folder?.path ?? path.trim();
    const r = await createProject(rt, {
      name: derived || 'プロジェクト',
      ...(kind === 'code'
        ? {
            repoPath: where,
            ...(defaultBranch ? { defaultBranch } : {}),
            ...(testCommand.trim() ? { testCommand: testCommand.trim() } : {}),
          }
        : { folderPath: where }),
    });
    setBusy(false);
    if (!r.ok) {
      setError(r.error);
      return;
    }
    useUi.getState().setProject(r.project.id);
    toast({
      title: `プロジェクト「${r.project.name}」を追加しました`,
      detail: r.project.defaultBranch ? `既定ブランチ: ${r.project.defaultBranch}` : undefined,
      tone: 'success',
      sticky: false,
    });
    onDone(r.project);
  };

  return (
    <form
      className="flex w-full flex-col gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <div>
        <FieldLabel htmlFor="proj-path">フォルダ</FieldLabel>
        <input
          id="proj-path"
          autoFocus
          className={`${inputClass} font-mono`}
          value={path}
          onChange={(e) => {
            setPath(e.target.value);
            setError(null);
            inspect(e.target.value, 350);
          }}
          onPaste={(e) => {
            // A pasted path is complete: check it at once instead of after the typing pause
            // (and drop the quotes of Explorer's "Copy as path").
            const pasted = e.clipboardData
              .getData('text')
              .trim()
              .replace(/^"(.*)"$/, '$1');
            if (pasted && !path) {
              e.preventDefault();
              adoptPath(pasted);
            }
          }}
          onBlur={() => {
            if (path.trim() && check?.path !== path.trim()) inspect(path, 0);
          }}
          placeholder="C:\work\my-project"
          spellCheck={false}
          aria-invalid={!!error || blocked}
          aria-describedby="proj-path-status"
        />
        <div id="proj-path-status" aria-live="polite">
          {error ? (
            <p className="mt-1 text-meta text-st-failed">{error}</p>
          ) : checking ? (
            <p className="mt-1 text-meta text-fg-3">フォルダを確認しています…</p>
          ) : folder && !folder.ok ? (
            <p className="mt-1 text-meta text-st-failed">
              {folder.reason ?? 'このフォルダはプロジェクトにできません'}
            </p>
          ) : folder && !folder.existingProjectId ? (
            kind === 'code' ? (
              <KindLine kind="code">
                {repo && branchText(repo) && (
                  <span className="flex items-center gap-1 font-mono">
                    <GitBranch size={11} strokeWidth={2} />
                    {branchText(repo)}
                  </span>
                )}
                <span>作業コピーで作業し、反映するまでこのフォルダは変わりません</span>
              </KindLine>
            ) : (
              <KindLine kind="folder">
                <span>エージェントがこのフォルダを直接書き換えます</span>
              </KindLine>
            )
          ) : (
            !folder && <Hint>エクスプローラーの「パスのコピー」を貼り付けられます</Hint>
          )}
        </div>
        {rootHint && !folder?.existingProjectId && (
          <button
            type="button"
            className="mt-1 flex max-w-full items-center gap-1 text-meta text-accent hover:underline"
            onClick={() => adoptPath(rootHint)}
            data-testid="use-repo-root"
          >
            <FolderGit2 size={12} strokeWidth={2} className="shrink-0" />
            <span className="truncate">リポジトリ {rootHint} をコードとして追加する</span>
          </button>
        )}
        {folder?.ok && folder.existingProjectId && (
          <div
            className="mt-2 flex items-center gap-2 rounded-sm bg-canvas px-2.5 py-2 text-meta text-fg-2"
            data-testid="existing-project"
          >
            <Folder size={13} strokeWidth={1.75} className="shrink-0 text-fg-3" />
            <span className="min-w-0 flex-1">
              このフォルダは{existing ? `プロジェクト「${existing.name}」` : '既にプロジェクト'}
              として追加されています。
            </span>
            {existing && (
              <Button
                size="sm"
                onClick={() => {
                  useUi.getState().setProject(existing.id);
                  onDone(existing);
                }}
              >
                このプロジェクトを開く
              </Button>
            )}
          </div>
        )}
        {kind === 'code' && !folder?.existingProjectId && dirtyText(repo?.isDirty ?? null) && (
          <div
            className="mt-2 flex gap-2 rounded-sm px-2.5 py-2 text-meta text-fg-2"
            style={{
              background: 'color-mix(in oklch, var(--st-awaiting_approval) 10%, transparent)',
            }}
            data-testid="dirty-warning"
          >
            <TriangleAlert
              size={13}
              strokeWidth={1.75}
              className="mt-px shrink-0 text-st-awaiting_approval"
            />
            <span>
              {dirtyText(repo?.isDirty ?? null)}
              。作業コピーは最後のコミットから作られるため、未コミットの変更はエージェントに見えません。必要ならコミットしてから始めてください。
            </span>
          </div>
        )}
      </div>
      <div
        className={
          compact || kind === 'folder' ? 'grid grid-cols-1 gap-3' : 'grid grid-cols-2 gap-3'
        }
      >
        <div>
          <FieldLabel htmlFor="proj-name">名前</FieldLabel>
          <input
            id="proj-name"
            className={inputClass}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={folder?.suggestedName || folderName(path) || 'my-project'}
          />
        </div>
        {kind === 'code' && (
          <div>
            <FieldLabel htmlFor="proj-branch">既定ブランチ</FieldLabel>
            <input
              id="proj-branch"
              className={`${inputClass} font-mono`}
              value={branch}
              onChange={(e) => setBranch(e.target.value)}
              placeholder={detectedBranch ? `${detectedBranch}（検出）` : '自動で検出'}
              spellCheck={false}
            />
          </div>
        )}
      </div>
      {kind === 'code' && (
        <div>
          <FieldLabel htmlFor="proj-test">テストコマンド</FieldLabel>
          <input
            id="proj-test"
            className={`${inputClass} font-mono`}
            value={testCommand}
            onChange={(e) => setTest({ value: e.target.value, touched: true })}
            placeholder="pnpm test"
            spellCheck={false}
          />
          <Hint>
            {folder?.suggestedTestCommand &&
            !test.touched &&
            testCommand === folder.suggestedTestCommand
              ? 'リポジトリから検出しました。統合のあとにこのコマンドで検証します。'
              : '統合のあとにこのコマンドで検証します。空なら検証を省略します。'}
          </Hint>
        </div>
      )}
      <div className="mt-1 flex justify-end gap-2">
        <Button variant="ghost" onClick={() => onDone(null)}>
          {compact ? 'あとで' : 'キャンセル'}
        </Button>
        <Button
          type="submit"
          variant="primary"
          disabled={!path.trim() || busy || blocked}
          hint={
            !blocked
              ? undefined
              : folder?.existingProjectId
                ? 'このフォルダは追加済みです'
                : '使えるフォルダを指定してください'
          }
        >
          {busy ? '確認しています…' : 'プロジェクトを追加'}
        </Button>
      </div>
    </form>
  );
}

/** Where a project lives: its repository (code) or its folder. */
export function ProjectPlace({ project }: { project: Project }) {
  const Icon = project.repoPath ? FolderGit2 : Folder;
  return (
    <div className="flex items-center gap-2 rounded-sm bg-canvas px-2.5 py-2 font-mono text-meta break-all text-fg-2">
      <Icon size={13} strokeWidth={1.75} className="shrink-0 text-fg-3" />
      {project.repoPath ?? project.folderPath ?? '場所なし'}
    </div>
  );
}

export function EditProjectForm({ project, onDone }: { project: Project; onDone: () => void }) {
  const rt = useRuntime();
  const [name, setName] = useState(project.name);
  const [branch, setBranch] = useState(project.defaultBranch ?? '');
  const [testCommand, setTestCommand] = useState(project.testCommand ?? '');
  const [profile, setProfile] = useState<PermissionProfile | null>(
    project.permissionProfile ?? null,
  );
  const globalDefault = useSettings().data?.defaultPermissionProfile ?? DEFAULT_PROFILE;
  const dirty =
    profile !== (project.permissionProfile ?? null) ||
    name.trim() !== project.name ||
    (branch.trim() || null) !== project.defaultBranch ||
    (testCommand.trim() || null) !== project.testCommand;
  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        if (!name.trim()) return;
        onDone();
        void updateProject(rt, project, {
          ...(name.trim() !== project.name ? { name: name.trim() } : {}),
          ...((branch.trim() || null) !== project.defaultBranch
            ? { defaultBranch: branch.trim() || null }
            : {}),
          ...((testCommand.trim() || null) !== project.testCommand
            ? { testCommand: testCommand.trim() || null }
            : {}),
          ...(profile !== (project.permissionProfile ?? null)
            ? { permissionProfile: profile }
            : {}),
        });
      }}
    >
      <ProjectPlace project={project} />
      <div>
        <FieldLabel htmlFor="edit-name">名前</FieldLabel>
        <input
          id="edit-name"
          className={inputClass}
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
      </div>
      {project.repoPath && (
        <>
          <div>
            <FieldLabel htmlFor="edit-branch">既定ブランチ</FieldLabel>
            <input
              id="edit-branch"
              className={`${inputClass} font-mono`}
              value={branch}
              onChange={(e) => setBranch(e.target.value)}
              placeholder="main"
              spellCheck={false}
            />
            <Hint>エージェントの作業コピーはここから作られ、反映はここに入ります。</Hint>
          </div>
          <div>
            <FieldLabel htmlFor="edit-test">テストコマンド</FieldLabel>
            <input
              id="edit-test"
              className={`${inputClass} font-mono`}
              value={testCommand}
              onChange={(e) => setTestCommand(e.target.value)}
              placeholder="pnpm test"
              spellCheck={false}
            />
            <Hint>統合のあとに実行します。空なら検証を省略します。</Hint>
          </div>
        </>
      )}
      <div>
        <FieldLabel>エージェントの権限</FieldLabel>
        <ProfilePicker
          label="エージェントの権限"
          value={profile}
          onChange={setProfile}
          inherit={globalDefault}
        />
        <HardRulesNote />
      </div>
      <div>
        <FieldLabel>記憶した許可</FieldLabel>
        <RememberedRules projectId={project.id} />
      </div>
      <div className="mt-1 flex justify-end gap-2">
        <Button variant="ghost" onClick={onDone}>
          キャンセル
        </Button>
        <Button type="submit" variant="primary" disabled={!dirty || !name.trim()}>
          保存
        </Button>
      </div>
    </form>
  );
}

/** Compact facts for menus and the panel: `⑂ main · ⚗ pnpm test`. */
export function ProjectFacts({ project }: { project: Project }) {
  return (
    <span className="flex min-w-0 items-center gap-3 text-meta text-fg-3">
      <span className="flex items-center gap-1 font-mono">
        <GitBranch size={12} strokeWidth={2} />
        {project.defaultBranch ?? '未設定'}
      </span>
      <span className="flex min-w-0 items-center gap-1 font-mono">
        <TestTube2 size={12} strokeWidth={2} />
        <span className="truncate">{project.testCommand ?? 'テストなし'}</span>
      </span>
    </span>
  );
}

/** Mounted once (App): `ui.projectDialog` decides add vs. edit. */
export function ProjectDialog() {
  const dialog = useUi((s) => s.projectDialog);
  const setDialog = useUi((s) => s.setProjectDialog);
  const projects = useProjects().data ?? NONE;
  const editing =
    dialog?.kind === 'edit' ? (projects.find((p) => p.id === dialog.projectId) ?? null) : null;
  const close = () => setDialog(null);
  return (
    <Dialog
      open={!!dialog && (dialog.kind === 'new' || !!editing)}
      onOpenChange={(o) => !o && close()}
      title={dialog?.kind === 'edit' ? 'プロジェクトの設定' : 'プロジェクトを追加'}
      className="w-[520px]"
    >
      {dialog?.kind === 'new' && <NewProjectForm onDone={close} />}
      {editing && <EditProjectForm key={editing.id} project={editing} onDone={close} />}
    </Dialog>
  );
}
