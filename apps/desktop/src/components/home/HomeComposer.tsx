import type { Project } from '@acc/protocol';
import { ChevronDown, Loader2, Play, Sparkles } from 'lucide-react';
import { useState } from 'react';
import { promptConnectionThen } from '../../app/connect';
import { startDemo } from '../../app/demo';
import { askAssistant, workPlaceOf, workspaceHint } from '../../daemon/assistant';
import { useMethods, useProjects, useSettings } from '../../daemon/queries';
import { useRuntime } from '../../daemon/runtime';
import { cn } from '../../lib/cn';
import { WORKSPACE_META, type WorkspaceKind } from '../../lib/states';
import { useUi } from '../../store/ui';
import { composerKeyAction } from '../focus/Composer';
import { agentModelFilter } from '../focus/Draft';
import { ModelPicker } from '../focus/ModelPicker';
import { Button } from '../ui/Button';
import { Menu, MenuContent, MenuItem, MenuTrigger } from '../ui/Menu';
import { Tooltip } from '../ui/Tooltip';
import { AssistantLine } from './AssistantLine';

const NO_PROJECTS: Project[] = [];
/** Key of the home field's text in the UI store. */
export const HOME_DRAFT_KEY = '__home__';

/** What a request can look like (ui-rework spec §3.4): examples under the empty home's field, not explanations. */
export const EXAMPLES = [
  '来月のローンチ準備を進めて',
  'ログイン画面のエラー文言とテストを直して',
  '毎朝 9 時に昨日のまとめを作って',
];

/** Projects a workspace kind can use: a folder needs a folder, code a git repository. */
function candidates(projects: readonly Project[], kind: WorkspaceKind): Project[] {
  if (kind === 'folder') return projects.filter((p) => !!p.folderPath);
  if (kind === 'worktree') return projects.filter((p) => !!p.repoPath);
  return [];
}

/**
 * 何を頼みますか (right-hand spec §2.1): the one way to ask for something, and the one person
 * it goes to — the assistant. Enter sends the words to it and stays home; its reply appears
 * above the field (AssistantLine) and new lanes are born as it starts work. Ctrl+Enter sends
 * and opens its conversation. The workspace toggle (自動 / folder / code): a folder or code
 * is held to by the daemon (`workPlace`), and also told to the assistant as a hint. In the middle (`center`: the empty home and Ctrl+N) it is larger, examples cycle under
 * it and 試してみる starts the demo (the empty home). What is typed is kept in the UI store, so
 * it survives leaving home and the empty home turning into the board. The first real request
 * without a saved LLM endpoint brings up the connection prompt first; the request goes once it
 * closes.
 */
export function HomeComposer({ center = false }: { center?: boolean }) {
  const rt = useRuntime();
  const projects = (useProjects().data ?? NO_PROJECTS).filter((p) => !p.archivedAt);
  const settings = useSettings().data;
  const methods = useMethods();
  const uiProjectId = useUi((s) => s.projectId);
  const text = useUi((s) => s.drafts[HOME_DRAFT_KEY] ?? '');
  const setDraft = useUi((s) => s.setDraft);
  const setText = (t: string) => setDraft(HOME_DRAFT_KEY, t);
  // Kept in the UI store, like the words: the empty home and the board each have their field.
  const { kind, projectId: pickedProjectId, model } = useUi((s) => s.homeChoice);
  const setHomeChoice = useUi((s) => s.setHomeChoice);
  const setKind = (k: WorkspaceKind) => setHomeChoice({ kind: k });
  const setPickedProjectId = (id: string | null) => setHomeChoice({ projectId: id });
  // The model for the work this request starts; none: the assistant picks from the roster.
  const setModel = (m: string | null) => setHomeChoice({ model: m });
  const [preparing, setPreparing] = useState(false);
  const roster = [
    ...new Set([
      ...(settings?.modelRules ?? []).map((r) => r.model),
      ...(settings?.defaultModel ? [settings.defaultModel] : []),
    ]),
  ];

  // The project the workspace comes from: the one picked here, else the current one, else the first that fits.
  const fits = candidates(projects, kind);
  const project =
    fits.find((p) => p.id === pickedProjectId) ??
    fits.find((p) => p.id === uiProjectId) ??
    fits[0] ??
    null;
  // A folder or the code picked here: Claude Code does the work, on a model it can run.
  const allow = agentModelFilter(!!workPlaceOf(kind, project), settings);
  const workModel = model && (!allow || allow(model)) ? model : null;

  const send = async (openIt: boolean) => {
    const t = text.trim();
    if (!t) return;
    const go = async () => {
      setText('');
      const id = await askAssistant(rt, t, {
        hint: workspaceHint(kind, project),
        model: workModel,
        place: workPlaceOf(kind, project),
      });
      if (!id) {
        // Nothing was sent: give the words back.
        setText(t);
        return;
      }
      if (openIt) useUi.getState().openSession(id);
    };
    if (!promptConnectionThen(settings, () => void go())) await go();
  };

  const tryDemo = () => {
    if (preparing) return;
    setPreparing(true);
    void startDemo(rt, methods).finally(() => setPreparing(false));
  };

  const toggle = (
    <WorkspaceToggle
      kind={kind}
      projects={projects}
      project={project}
      large={center}
      onKind={setKind}
      onProject={(id) => setPickedProjectId(id)}
    />
  );

  const field = (
    <div
      className={cn(
        'flex min-w-0 items-center gap-1 rounded-md border border-transparent bg-surface pr-1.5 pl-3 focus-within:border-[var(--focus-ring)]',
        center ? 'h-12 w-full' : 'h-11 w-full',
      )}
    >
      <input
        autoFocus={center}
        value={text}
        placeholder="何を頼みますか"
        aria-label="何を頼みますか"
        data-composer-input
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          // One line: Shift+Enter neither sends nor breaks the line (a newline here would be a send by accident).
          if (e.key === 'Enter' && e.shiftKey) {
            e.preventDefault();
            return;
          }
          const action = composerKeyAction({
            key: e.key,
            shiftKey: e.shiftKey,
            ctrlKey: e.ctrlKey,
            metaKey: e.metaKey,
            altKey: e.altKey,
            isComposing: e.nativeEvent.isComposing,
            keyCode: e.nativeEvent.keyCode,
          });
          if (action === 'send') {
            e.preventDefault();
            void send(e.ctrlKey || e.metaKey);
          }
        }}
        className={cn(
          'h-full min-w-0 flex-1 bg-transparent px-1 text-fg placeholder:text-fg-4',
          center ? 'text-[15px]' : 'text-chat',
        )}
      />
      <ModelPicker
        value={workModel}
        fallback={null}
        roster={roster}
        autoLabel="自動"
        autoHint={allow ? 'Claude Code の既定のモデルで動きます' : '設定の名簿に沿って選びます'}
        {...(allow ? { allow } : {})}
        onChange={setModel}
      />
      {!center && projects.length > 0 && toggle}
    </div>
  );

  if (!center) {
    return (
      <div className="flex min-w-0 flex-col gap-1.5">
        <AssistantLine />
        {field}
      </div>
    );
  }
  // The middle of an empty screen: the field, examples of what to ask, where the work happens, and the demo.
  return (
    <div className="flex w-full flex-col items-center gap-3" data-composer-center>
      <AssistantLine className="w-full" />
      {field}
      <Examples />
      {projects.length > 0 && toggle}
      {center && (
        <Button
          variant="ghost"
          size="md"
          className="mt-4"
          disabled={preparing}
          onClick={tryDemo}
          icon={
            preparing ? (
              <Loader2 size={14} className="animate-spin" />
            ) : (
              <Play size={14} strokeWidth={1.75} />
            )
          }
        >
          試してみる
        </Button>
      )}
    </div>
  );
}

/**
 * Three examples take turns (4s each, 180ms cross-fade) by CSS alone; with reduced motion the
 * first one stays. Decoration for the eye: hidden from assistive tech.
 */
function Examples() {
  return (
    <div aria-hidden className="relative h-5 w-full" data-examples>
      {EXAMPLES.map((e, i) => (
        <span
          key={e}
          className="acc-example absolute inset-x-0 top-0 truncate text-center text-ui text-fg-3"
          style={{ animationDelay: `${i * 4}s` }}
        >
          {e}
        </span>
      ))}
    </div>
  );
}

const KINDS: { kind: WorkspaceKind; label: string }[] = [
  // 自動: the assistant decides where (or whether) the work happens; a folder or code is held to.
  { kind: 'none', label: '自動（右腕が決める）' },
  { kind: 'folder', label: WORKSPACE_META.folder.label },
  { kind: 'worktree', label: WORKSPACE_META.worktree.label },
];

/**
 * Where the work should happen: 自動 (the assistant decides), a folder, or a project's code —
 * a folder or code is not a wish: the daemon starts the work there. A folder or code shows
 * the project it comes from (a menu when there are several).
 * A folder or code without any such project yet opens 「プロジェクトを追加」.
 */
function WorkspaceToggle({
  kind,
  projects,
  project,
  large,
  onKind,
  onProject,
}: {
  kind: WorkspaceKind;
  projects: readonly Project[];
  project: Project | null;
  large: boolean;
  onKind: (k: WorkspaceKind) => void;
  onProject: (projectId: string) => void;
}) {
  const fits = candidates(projects, kind);
  return (
    <span className="flex shrink-0 items-center gap-1">
      {kind !== 'none' && project && (
        <Menu>
          <MenuTrigger asChild disabled={fits.length < 2}>
            <button
              type="button"
              data-workspace-project
              className="flex h-6 max-w-40 items-center gap-1 rounded-sm bg-selected px-1.5 text-meta text-fg-2 hover:text-fg disabled:hover:text-fg-2"
            >
              <span className="truncate">{project.name}</span>
              {fits.length > 1 && <ChevronDown size={12} strokeWidth={2} className="shrink-0" />}
            </button>
          </MenuTrigger>
          <MenuContent align="end">
            {fits.map((p) => (
              <MenuItem key={p.id} checked={p.id === project.id} onSelect={() => onProject(p.id)}>
                {p.name}
              </MenuItem>
            ))}
          </MenuContent>
        </Menu>
      )}
      <span
        role="radiogroup"
        aria-label="作業場所"
        className={cn(
          'flex items-center rounded-sm p-0.5',
          large ? 'gap-0.5 bg-surface' : 'bg-canvas',
        )}
      >
        {KINDS.map(({ kind: k, label }) => {
          const Icon = k === 'none' ? Sparkles : WORKSPACE_META[k].icon;
          const none = k !== 'none' && candidates(projects, k).length === 0;
          const on = kind === k;
          return (
            <Tooltip key={k} content={label}>
              <button
                type="button"
                role="radio"
                aria-checked={on}
                aria-label={label}
                data-workspace={k}
                onClick={() => {
                  if (none) {
                    useUi.getState().setProjectDialog({ kind: 'new' });
                    return;
                  }
                  onKind(k);
                }}
                className={cn(
                  'flex items-center justify-center rounded-[3px] transition-colors duration-[120ms]',
                  large ? 'size-8' : 'size-6',
                  on
                    ? 'bg-selected text-fg'
                    : 'text-fg-3 hover:text-fg aria-disabled:text-fg-4 aria-disabled:opacity-50',
                )}
              >
                <Icon size={large ? 16 : 13} strokeWidth={1.75} />
              </button>
            </Tooltip>
          );
        })}
      </span>
    </span>
  );
}
