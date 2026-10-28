import type { Project } from '@acc/protocol';
import { FolderGit2, GitBranch, TestTube2 } from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { createProject, updateProject } from '../../daemon/orchestration';
import { useProjects } from '../../daemon/queries';
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
export function NewProjectForm({ onDone, compact = false }: { onDone: (p: Project | null) => void; compact?: boolean }) {
  const rt = useRuntime();
  const [path, setPath] = useState('');
  const [name, setName] = useState('');
  const [testCommand, setTestCommand] = useState('');
  const [branch, setBranch] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const derived = name.trim() || folderName(path);

  const submit = async () => {
    if (!path.trim() || busy) return;
    setBusy(true);
    setError(null);
    const r = await createProject(rt, {
      repoPath: path.trim(),
      name: derived || 'プロジェクト',
      ...(branch.trim() ? { defaultBranch: branch.trim() } : {}),
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
          }}
          placeholder="C:\work\my-repo"
          spellCheck={false}
          aria-invalid={!!error}
        />
        {error ? <p className="mt-1 text-meta text-st-failed">{error}</p> : <Hint>リポジトリのルート（.git があるフォルダ）を絶対パスで指定します。</Hint>}
      </div>
      <div className={compact ? 'grid grid-cols-1 gap-3' : 'grid grid-cols-2 gap-3'}>
        <div>
          <FieldLabel htmlFor="proj-name">名前</FieldLabel>
          <input id="proj-name" className={inputClass} value={name} onChange={(e) => setName(e.target.value)} placeholder={folderName(path) || 'my-repo'} />
        </div>
        <div>
          <FieldLabel htmlFor="proj-branch">既定ブランチ</FieldLabel>
          <input id="proj-branch" className={inputClass} value={branch} onChange={(e) => setBranch(e.target.value)} placeholder="自動で検出" spellCheck={false} />
        </div>
      </div>
      <div>
        <FieldLabel htmlFor="proj-test">テストコマンド</FieldLabel>
        <input
          id="proj-test"
          className={`${inputClass} font-mono`}
          value={testCommand}
          onChange={(e) => setTestCommand(e.target.value)}
          placeholder="pnpm test"
          spellCheck={false}
        />
        <Hint>統合のあとにこのコマンドで検証します。空なら検証を省略します。</Hint>
      </div>
      <div className="mt-1 flex justify-end gap-2">
        <Button variant="ghost" onClick={() => onDone(null)}>
          {compact ? 'あとで' : 'キャンセル'}
        </Button>
        <Button type="submit" variant="primary" disabled={!path.trim() || busy}>
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
          ...((branch.trim() || null) !== project.defaultBranch ? { defaultBranch: branch.trim() || null } : {}),
          ...((testCommand.trim() || null) !== project.testCommand ? { testCommand: testCommand.trim() || null } : {}),
        });
      }}
    >
      <div className="flex items-center gap-2 rounded-sm bg-canvas px-2.5 py-2 font-mono text-meta break-all text-fg-2">
        <FolderGit2 size={13} strokeWidth={1.5} className="shrink-0 text-fg-3" />
        {project.repoPath ?? 'リポジトリなし'}
      </div>
      <div>
        <FieldLabel htmlFor="edit-name">名前</FieldLabel>
        <input id="edit-name" className={inputClass} value={name} onChange={(e) => setName(e.target.value)} />
      </div>
      <div>
        <FieldLabel htmlFor="edit-branch">既定ブランチ</FieldLabel>
        <input id="edit-branch" className={`${inputClass} font-mono`} value={branch} onChange={(e) => setBranch(e.target.value)} placeholder="main" spellCheck={false} />
        <Hint>Worker の worktree はここから作られ、統合はここへ反映されます。</Hint>
      </div>
      <div>
        <FieldLabel htmlFor="edit-test">テストコマンド</FieldLabel>
        <input id="edit-test" className={`${inputClass} font-mono`} value={testCommand} onChange={(e) => setTestCommand(e.target.value)} placeholder="pnpm test" spellCheck={false} />
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
  const editing = dialog?.kind === 'edit' ? (projects.find((p) => p.id === dialog.projectId) ?? null) : null;
  const close = () => setDialog(null);
  return (
    <Dialog
      open={!!dialog && (dialog.kind === 'new' || !!editing)}
      onOpenChange={(o) => !o && close()}
      title={dialog?.kind === 'edit' ? 'プロジェクトの設定' : 'プロジェクトを追加'}
      description={
        dialog?.kind === 'edit' ? undefined : 'エージェントはこのリポジトリから作った worktree で作業します。'
      }
      className="w-[520px]"
    >
      {dialog?.kind === 'new' && <NewProjectForm onDone={close} />}
      {editing && <EditProjectForm key={editing.id} project={editing} onDone={close} />}
    </Dialog>
  );
}
