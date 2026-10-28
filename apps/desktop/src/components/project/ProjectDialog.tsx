import type { Project } from '@acc/protocol';
import { Check, FolderGit2, GitBranch, TestTube2, TriangleAlert } from 'lucide-react';
import { type ReactNode, useRef, useState } from 'react';
import { createProject, inspectRepo, updateProject } from '../../daemon/orchestration';
import { useProjects } from '../../daemon/queries';
import { type RepoInspection, branchText, dirtyText, suggestedRoot } from '../../model/repo';
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

/**
 * Add a local git repository as a project. The daemon validates the path and that it is a
 * repository; the checked-out branch becomes the default branch (editable here or later).
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
  const [check, setCheck] = useState<{ path: string; result: RepoInspection | null; pending: boolean } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inspection = check && check.path === path.trim() && !check.pending ? check.result : null;
  const checking = !!check?.pending && check.path === path.trim();
  const derived = name.trim() || inspection?.suggestedName || folderName(path);
  const rootHint = suggestedRoot(inspection, path);
  const existing = inspection?.existingProjectId
    ? (projects.find((p) => p.id === inspection.existingProjectId) ?? null)
    : null;
  const defaultBranch = branch.trim() || inspection?.defaultBranch || '';

  /** Validate the folder while typing (debounced), before anything is created. */
  const inspect = (value: string, delay: number) => {
    if (timer.current) clearTimeout(timer.current);
    const p = value.trim();
    if (!p) {
      setCheck(null);
      return;
    }
    setCheck({ path: p, result: null, pending: true });
    timer.current = setTimeout(() => {
      void inspectRepo(rt, p).then((result) => {
        setCheck((cur) => (cur?.path === p ? { path: p, result, pending: false } : cur));
        // Prefill what the repository tells (never over what the user typed).
        const detected = result?.suggestedTestCommand;
        if (detected) setTest((cur) => (cur.touched || cur.value ? cur : { value: detected, touched: false }));
      });
    }, delay);
  };

  const adoptPath = (value: string) => {
    setPath(value);
    setError(null);
    inspect(value, 0);
  };

  // Not a repository root, or already a project: nothing to create (the daemon would accept
  // a duplicate; the form points at the existing project instead).
  const blocked = !!inspection && (!inspection.ok || !!inspection.existingProjectId);

  const submit = async () => {
    if (!path.trim() || busy || blocked) return;
    setBusy(true);
    setError(null);
    const r = await createProject(rt, {
      repoPath: inspection?.repoRoot ?? path.trim(),
      name: derived || 'プロジェクト',
      ...(defaultBranch ? { defaultBranch } : {}),
      ...(testCommand.trim() ? { testCommand: testCommand.trim() } : {}),
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
        <FieldLabel htmlFor="proj-path">Git リポジトリのフォルダ</FieldLabel>
        <input
          id="proj-path"
          autoFocus
          className={inputClass}
          value={path}
          onChange={(e) => {
            setPath(e.target.value);
            setError(null);
            inspect(e.target.value, 350);
          }}
          onPaste={(e) => {
            // A pasted path is complete: check it at once instead of after the typing pause
            // (and drop the quotes of Explorer's "Copy as path").
            const pasted = e.clipboardData.getData('text').trim().replace(/^"(.*)"$/, '$1');
            if (pasted && !path) {
              e.preventDefault();
              adoptPath(pasted);
            }
          }}
          onBlur={() => {
            if (path.trim() && check?.path !== path.trim()) inspect(path, 0);
          }}
          placeholder="C:\work\my-repo"
          spellCheck={false}
          aria-invalid={!!error || blocked}
          aria-describedby="proj-path-status"
        />
        <div id="proj-path-status" aria-live="polite">
          {error ? (
            <p className="mt-1 text-meta text-st-failed">{error}</p>
          ) : checking ? (
            <p className="mt-1 text-meta text-fg-3">フォルダを確認しています…</p>
          ) : inspection && !inspection.ok ? (
            <p className="mt-1 flex flex-wrap items-center gap-x-2 text-meta text-st-failed">
              <span>{inspection.reason ?? 'このフォルダはプロジェクトにできません'}</span>
              {rootHint && (
                <button
                  type="button"
                  className="min-w-0 truncate text-accent hover:underline"
                  onClick={() => adoptPath(rootHint)}
                >
                  ルート {rootHint} を使う
                </button>
              )}
            </p>
          ) : inspection ? (
            <p className="mt-1 flex flex-wrap items-center gap-x-2 text-meta text-fg-3">
              <span className="flex items-center gap-1 text-st-completed">
                <Check size={12} strokeWidth={2} />
                git リポジトリ
              </span>
              {branchText(inspection) && (
                <span className="flex items-center gap-1 font-mono">
                  <GitBranch size={11} strokeWidth={1.75} />
                  {branchText(inspection)}
                </span>
              )}
            </p>
          ) : (
            <Hint>リポジトリのルート（.git があるフォルダ）を絶対パスで指定します。</Hint>
          )}
        </div>
        {inspection?.ok && inspection.existingProjectId && (
          <div
            className="mt-2 flex items-center gap-2 rounded-sm bg-canvas px-2.5 py-2 text-meta text-fg-2"
            data-testid="existing-project"
          >
            <FolderGit2 size={13} strokeWidth={1.75} className="shrink-0 text-fg-3" />
            <span className="min-w-0 flex-1">
              このリポジトリは{existing ? `プロジェクト「${existing.name}」` : '既にプロジェクト'}として追加されています。
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
        {inspection?.ok && !inspection.existingProjectId && dirtyText(inspection.isDirty) && (
          <div
            className="mt-2 flex gap-2 rounded-sm px-2.5 py-2 text-meta text-fg-2"
            style={{ background: 'color-mix(in oklch, var(--st-awaiting_approval) 10%, transparent)' }}
            data-testid="dirty-warning"
          >
            <TriangleAlert size={13} strokeWidth={1.75} className="mt-px shrink-0 text-st-awaiting_approval" />
            <span>
              {dirtyText(inspection.isDirty)}。Worker の worktree は最後のコミットから作られるため、未コミットの変更は Worker
              に見えません。必要ならコミットしてから始めてください。
            </span>
          </div>
        )}
      </div>
      <div className={compact ? 'grid grid-cols-1 gap-3' : 'grid grid-cols-2 gap-3'}>
        <div>
          <FieldLabel htmlFor="proj-name">名前</FieldLabel>
          <input
            id="proj-name"
            className={inputClass}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={inspection?.suggestedName || folderName(path) || 'my-repo'}
          />
        </div>
        <div>
          <FieldLabel htmlFor="proj-branch">既定ブランチ</FieldLabel>
          <input
            id="proj-branch"
            className={inputClass}
            value={branch}
            onChange={(e) => setBranch(e.target.value)}
            placeholder={inspection?.defaultBranch ? `${inspection.defaultBranch}（検出）` : '自動で検出'}
            spellCheck={false}
          />
        </div>
      </div>
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
          {inspection?.suggestedTestCommand &&
          !test.touched &&
          testCommand === inspection.suggestedTestCommand
            ? 'リポジトリから検出しました。統合のあとにこのコマンドで検証します。'
            : '統合のあとにこのコマンドで検証します。空なら検証を省略します。'}
        </Hint>
      </div>
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
              : inspection?.existingProjectId
                ? 'このリポジトリは追加済みです'
                : 'git リポジトリのルートフォルダを指定してください'
          }
        >
          {busy ? '確認しています…' : 'プロジェクトを追加'}
        </Button>
      </div>
    </form>
  );
}

function EditProjectForm({ project, onDone }: { project: Project; onDone: () => void }) {
  const rt = useRuntime();
  const [name, setName] = useState(project.name);
  const [branch, setBranch] = useState(project.defaultBranch ?? '');
  const [testCommand, setTestCommand] = useState(project.testCommand ?? '');
  const dirty =
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
        });
      }}
    >
      <div className="flex items-center gap-2 rounded-sm bg-canvas px-2.5 py-2 font-mono text-meta break-all text-fg-2">
        <FolderGit2 size={13} strokeWidth={1.5} className="shrink-0 text-fg-3" />
        {project.repoPath ?? 'リポジトリなし'}
      </div>
      <div>
        <FieldLabel htmlFor="edit-name">名前</FieldLabel>
        <input
          id="edit-name"
          className={inputClass}
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
      </div>
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
        <Hint>Worker の worktree はここから作られ、統合はここへ反映されます。</Hint>
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
        <GitBranch size={12} strokeWidth={1.75} />
        {project.defaultBranch ?? '未設定'}
      </span>
      <span className="flex min-w-0 items-center gap-1 font-mono">
        <TestTube2 size={12} strokeWidth={1.75} />
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
      description={
        dialog?.kind === 'edit'
          ? undefined
          : 'エージェントはこのリポジトリから作った worktree で作業します。'
      }
      className="w-[520px]"
    >
      {dialog?.kind === 'new' && <NewProjectForm onDone={close} />}
      {editing && <EditProjectForm key={editing.id} project={editing} onDone={close} />}
    </Dialog>
  );
}
