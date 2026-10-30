import { motion } from 'motion/react';
import { connectionPromptClosed } from '../../app/connect';
import { useUi } from '../../store/ui';
import { LiteLlmForm } from '../settings/LiteLlmForm';
import { Button } from '../ui/Button';

/**
 * The connection prompt (ui-rework spec §3.4). Not a first-run screen: it appears the first
 * time a real request is sent while no LLM endpoint is saved, right over the home screen. The
 * LiteLLM Proxy URL and key with 確かめる, or あとで (the request goes to the mock models). Either
 * way the request that was waiting is sent when it closes, and it never asks again.
 */
export function Onboarding() {
  const open = useUi((s) => s.connectPromptOpen);
  if (!open) return null;
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="接続先"
      className="fixed inset-x-0 top-10 bottom-0 z-[65] flex items-start justify-center bg-overlay pt-[18vh]"
      onClick={(e) => {
        if (e.target === e.currentTarget) connectionPromptClosed();
      }}
    >
      <motion.div
        initial={{ opacity: 0, y: 4 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.18, ease: [0.16, 1, 0.3, 1] }}
        className="flex w-[400px] max-w-[calc(100vw-32px)] flex-col rounded-lg bg-raised p-6 shadow-modal"
      >
        <h1 className="mb-5 text-heading text-fg">接続先</h1>
        <LiteLlmForm onDone={connectionPromptClosed} doneLabel="始める" />
        <div className="mt-6 flex justify-end">
          <Button variant="ghost" size="md" onClick={connectionPromptClosed}>
            あとで
          </Button>
        </div>
      </motion.div>
    </div>
  );
}
