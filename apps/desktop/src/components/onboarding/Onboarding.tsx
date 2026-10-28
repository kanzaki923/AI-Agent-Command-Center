import { ArrowLeftRight, FolderGit2, Play } from 'lucide-react';
import { motion } from 'motion/react';
import { type ReactNode, useState } from 'react';
import { qk } from '../../daemon/keys';
import { useSessions, useSettings } from '../../daemon/queries';
import { useConnectionState, useRuntime } from '../../daemon/runtime';
import { upsertIn } from '../../daemon/sync';
import { cn } from '../../lib/cn';
import { toastError } from '../../store/toast';
import { useUi } from '../../store/ui';
import { LiteLlmForm } from '../settings/LiteLlmForm';
import { Button } from '../ui/Button';
import { FieldLabel, inputClass } from '../ui/Dialog';
import { Kbd } from '../ui/Kbd';

type Step = 'choose' | 'litellm' | 'project';

/** Goal pre-filled in the demo chat (the mock orchestrator turns it into 2 parallel tasks). */
const DEMO_GOAL = '認証まわりのドキュメントとテストを並列で整備して';

function ChoiceCard({
  active,
  icon,
  title,
  body,
  onClick,
  onFocus,
}: {
  active: boolean;
  icon: ReactNode;
  title: string;
  body: string;
  onClick: () => void;
  onFocus: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      onFocus={onFocus}
      onMouseEnter={onFocus}
      aria-pressed={active}
      className={cn(
        'flex h-40 flex-1 flex-col justify-start rounded-lg border p-5 text-left transition-colors duration-[120ms]',
        active ? 'border-[var(--focus-ring)] bg-selected' : 'border-line bg-surface hover:border-line-strong',
      )}
    >
      {/* Inner box: <button> centres its content vertically; keep it top-aligned. */}
      <span className="flex w-full flex-1 flex-col items-start justify-start gap-2">
        <span
          className={cn(
            'flex size-8 items-center justify-center rounded-md transition-colors duration-[120ms]',
            active ? 'bg-accent text-accent-fg' : 'bg-selected text-fg-2',
          )}
        >
          {icon}
        </span>
        <span className="mt-1 text-title text-fg">{title}</span>
        <span className="text-ui text-fg-3">{body}</span>
      </span>
    </button>
  );
}

function ProjectStep({ onDone }: { onDone: () => void }) {
  const rt = useRuntime();
  const [path, setPath] = useState('');
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const derivedName = name || path.split(/[\\/]/).filter(Boolean).pop() || '';
  const add = async () => {
    if (!path.trim()) return;
    try {
      const p = await rt.client.call('project.create', { name: derivedName || 'プロジェクト', repoPath: path.trim() });
      upsertIn(rt.queryClient, qk.projects, p);
      useUi.getState().setProject(p.id);
      onDone();
    } catch (err) {
      setError(toastError(err, 'プロジェクトを追加できませんでした').title);
    }
  };
  return (
    <form
      className="flex w-full flex-col gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        void add();
      }}
    >
      <div>
        <FieldLabel htmlFor="proj-path">Git リポジトリのフォルダ</FieldLabel>
        <input
          id="proj-path"
          autoFocus
          className={inputClass}
          value={path}
          onChange={(e) => setPath(e.target.value)}
          placeholder="C:\\work\\my-repo"
          spellCheck={false}
        />
      </div>
      <div>
        <FieldLabel htmlFor="proj-name">名前</FieldLabel>
        <input id="proj-name" className={inputClass} value={name} onChange={(e) => setName(e.target.value)} placeholder={derivedName || 'my-repo'} />
      </div>
      {error && <p className="text-meta text-st-failed">{error}</p>}
      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={onDone}>
          あとで
        </Button>
        <Button type="submit" variant="primary" disabled={!path.trim()}>
          プロジェクトを追加
        </Button>
      </div>
    </form>
  );
}

/**
 * First run (§8.1): one screen. LiteLLM Proxy or demo mode, then optionally a project.
 * Shown while nothing is configured and the user has not finished it before.
 */
export function Onboarding() {
  const done = useUi((s) => s.onboardingDone);
  const finish = useUi((s) => s.finishOnboarding);
  const settings = useSettings();
  const sessions = useSessions();
  const connected = useConnectionState() === 'open';
  const rt = useRuntime();
  const [step, setStep] = useState<Step>('choose');
  const [choice, setChoice] = useState<0 | 1>(0);
  const [startingDemo, setStartingDemo] = useState(false);

  const configured = !!settings.data && (settings.data.litellm.baseUrl != null || settings.data.litellm.hasApiKey);
  const used = (sessions.data?.length ?? 0) > 0;
  if (done || !connected || !settings.data || !sessions.data || (step === 'choose' && (configured || used))) return null;

  // Demo mode: the daemon prepares a sample repo, a project and an orchestrator chat on the
  // offline mock model (idempotent), and we open that chat with the goal pre-filled.
  const startDemo = async () => {
    if (startingDemo) return;
    setStartingDemo(true);
    try {
      const demo = await rt.client.call('system.setupDemo', {});
      upsertIn(rt.queryClient, qk.projects, demo.project);
      upsertIn(rt.queryClient, qk.sessions, demo.session);
      const ui = useUi.getState();
      ui.setProject(demo.project.id);
      if (!ui.drafts[demo.session.id]) ui.setDraft(demo.session.id, DEMO_GOAL);
      ui.openSession(demo.session.id);
      finish();
    } catch (err) {
      toastError(err, 'デモを準備できませんでした');
    } finally {
      setStartingDemo(false);
    }
  };

  const decide = (c: 0 | 1) => {
    if (c === 0) setStep('litellm');
    else void startDemo();
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="はじめに"
      className="fixed inset-x-0 top-10 bottom-0 z-[65] flex items-start justify-center bg-app pt-[14vh]"
      onKeyDown={(e) => {
        if (step !== 'choose') return;
        if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
          e.preventDefault();
          setChoice((c) => (c === 0 ? 1 : 0));
        } else if (e.key === 'Enter' && !(e.target instanceof HTMLButtonElement)) {
          e.preventDefault();
          decide(choice);
        }
      }}
      tabIndex={-1}
      // Programmatic focus target for ← → / Enter; never show a ring on the whole screen.
      style={{ outline: 'none', boxShadow: 'none' }}
      ref={(el) => {
        if (el && step === 'choose' && !el.contains(document.activeElement)) el.focus();
      }}
    >
      <motion.div
        key={step}
        initial={{ opacity: 0, y: 4 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.18, ease: [0.16, 1, 0.3, 1] }}
        className="flex w-[640px] max-w-[calc(100vw-32px)] flex-col items-center"
      >
        {step === 'choose' && (
          <>
            <h1 className="text-heading text-fg">AI エージェントのチームを始めましょう</h1>
            <p className="mt-2 text-ui text-fg-3">LLM の接続先を選んでください。あとから設定で変更できます。</p>
            <div className="mt-8 flex w-full gap-4">
              <ChoiceCard
                active={choice === 0}
                icon={<ArrowLeftRight size={16} strokeWidth={1.75} />}
                title="LiteLLM Proxy に接続"
                body="社内やお手元の Proxy を使います。"
                onClick={() => decide(0)}
                onFocus={() => setChoice(0)}
              />
              <ChoiceCard
                active={choice === 1}
                icon={<Play size={16} strokeWidth={1.75} />}
                title={startingDemo ? 'デモを準備しています…' : 'デモモードで試す'}
                body="サンプルのリポジトリと Orchestrator のチャットを用意します。組み込みの模擬モデルで、費用をかけずに並列実行を体験できます。"
                onClick={() => decide(1)}
                onFocus={() => setChoice(1)}
              />
            </div>
            <p className="mt-5 flex items-center gap-1.5 text-meta text-fg-4">
              <Kbd keys="ArrowLeft" />
              <Kbd keys="ArrowRight" /> で選択 · <Kbd keys="Enter" /> で決定
            </p>
          </>
        )}
        {step === 'litellm' && (
          <div className="w-full max-w-[440px]">
            <h1 className="text-heading text-fg">LiteLLM Proxy に接続</h1>
            <p className="mt-1 mb-6 text-ui text-fg-3">URL と API キーを入力して、接続を確かめます。</p>
            <LiteLlmForm onDone={() => setStep('project')} />
            <button type="button" onClick={() => setStep('choose')} className="mt-4 text-meta text-fg-3 hover:text-fg-2">
              ← 戻る
            </button>
          </div>
        )}
        {step === 'project' && (
          <div className="w-full max-w-[440px]">
            <span className="flex size-8 items-center justify-center rounded-md bg-selected text-fg-2">
              <FolderGit2 size={16} strokeWidth={1.75} />
            </span>
            <h1 className="mt-3 text-heading text-fg">プロジェクトを追加</h1>
            <p className="mt-1 mb-6 text-ui text-fg-3">エージェントはこのリポジトリの worktree で作業します。あとで追加しても構いません。</p>
            <ProjectStep onDone={finish} />
          </div>
        )}
      </motion.div>
    </div>
  );
}
