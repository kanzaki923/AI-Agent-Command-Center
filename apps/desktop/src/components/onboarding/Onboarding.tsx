import { ArrowLeftRight, FolderGit2, Play } from 'lucide-react';
import { motion } from 'motion/react';
import { type ReactNode, useState } from 'react';
import { startDemo } from '../../app/demo';
import { useMethods, useSessions, useSettings } from '../../daemon/queries';
import { useConnectionState, useRuntime } from '../../daemon/runtime';
import { cn } from '../../lib/cn';
import { useUi } from '../../store/ui';
import { NewProjectForm } from '../project/ProjectDialog';
import { LiteLlmForm } from '../settings/LiteLlmForm';
import { Kbd } from '../ui/Kbd';

type Step = 'choose' | 'litellm' | 'project';

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
  const methods = useMethods();
  const [step, setStep] = useState<Step>('choose');
  const [choice, setChoice] = useState<0 | 1>(0);
  const [preparing, setPreparing] = useState(false);

  const configured = !!settings.data && (settings.data.litellm.baseUrl != null || settings.data.litellm.hasApiKey);
  const used = (sessions.data?.length ?? 0) > 0;
  if (done || !connected || !settings.data || !sessions.data || (step === 'choose' && !preparing && (configured || used))) return null;

  const decide = (c: 0 | 1) => {
    if (c === 0) {
      setStep('litellm');
      return;
    }
    if (preparing) return;
    // Demo: straight into the design chat, already an orchestrator (§8.1: no extra steps).
    setPreparing(true);
    void startDemo(rt, methods).finally(() => setPreparing(false));
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
                title={preparing ? 'デモを準備しています…' : 'デモモードで試す'}
                body="組み込みの模擬モデルで、費用をかけずに Orchestrator と並列実行を体験できます。"
                onClick={() => decide(1)}
                onFocus={() => setChoice(1)}
              />
            </div>
            <p className="mt-5 flex items-center gap-1.5 text-meta text-fg-3">
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
            <NewProjectForm compact onDone={finish} />
          </div>
        )}
      </motion.div>
    </div>
  );
}
