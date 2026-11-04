import { motion } from 'motion/react';
import { connectionPromptCancelled, connectionPromptDone } from '../../app/connect';
import { useUi } from '../../store/ui';
import { LiteLlmForm } from '../settings/LiteLlmForm';
import { Button } from '../ui/Button';

/**
 * The connection prompt (ui-rework spec §3.4). Not a first-run screen: it appears the first
 * time a real request is sent while no LLM endpoint is saved, right over the home screen. The
 * LiteLLM Proxy URL and key with 確かめる → 始める, or モックで送る: either sends the request
 * that was waiting, and it never asks again. Closing it (outside, Esc) is a third, plain answer
 * — not now: nothing is sent and the words stay in the field.
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
        if (e.target === e.currentTarget) connectionPromptCancelled();
      }}
      onKeyDown={(e) => {
        if (e.key !== 'Escape') return;
        // Only this prompt closes (not the screen behind it).
        e.stopPropagation();
        connectionPromptCancelled();
      }}
    >
      <motion.div
        initial={{ opacity: 0, y: 4 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.18, ease: [0.16, 1, 0.3, 1] }}
        className="flex w-[400px] max-w-[calc(100vw-32px)] flex-col rounded-lg bg-raised p-6 shadow-modal"
      >
        <h1 className="mb-5 text-heading text-fg">接続先</h1>
        <LiteLlmForm onDone={connectionPromptDone} doneLabel="始める" />
        <div className="mt-6 flex justify-end">
          <Button variant="ghost" size="md" onClick={connectionPromptDone}>
            モックで送る
          </Button>
        </div>
      </motion.div>
    </div>
  );
}
