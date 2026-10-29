import { Loader2, Play } from 'lucide-react';
import { motion } from 'motion/react';
import { useState } from 'react';
import { startDemo } from '../../app/demo';
import { useMethods, useSessions, useSettings } from '../../daemon/queries';
import { useConnectionState, useRuntime } from '../../daemon/runtime';
import { useUi } from '../../store/ui';
import { LiteLlmForm } from '../settings/LiteLlmForm';
import { Button } from '../ui/Button';

/**
 * First run (spec §7): one screen. The LiteLLM Proxy URL and key with 確かめる, or
 * あとで（モックで試す）, which starts a demo conversation that leads three agents on mock
 * models. Shown while nothing is configured and nothing was used yet; once shown it stays
 * until finished (connecting changes the settings it was decided on).
 */
export function Onboarding() {
  const done = useUi((s) => s.onboardingDone);
  const finish = useUi((s) => s.finishOnboarding);
  const settings = useSettings().data;
  const sessions = useSessions().data;
  const connected = useConnectionState() === 'open';
  const rt = useRuntime();
  const methods = useMethods();
  const [shown, setShown] = useState(false);
  const [preparing, setPreparing] = useState(false);

  const configured = !!settings && (settings.litellm.baseUrl != null || settings.litellm.hasApiKey);
  const fresh = !!settings && !!sessions && !configured && sessions.length === 0;
  // Latch the decision (adjusting state while rendering): testing the connection saves it,
  // which must not close the screen before the model is chosen.
  if (!shown && !done && connected && fresh) setShown(true);
  if (done || !shown) return null;

  const tryMock = () => {
    if (preparing) return;
    setPreparing(true);
    void startDemo(rt, methods).finally(() => setPreparing(false));
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="はじめに"
      className="fixed inset-x-0 top-10 bottom-0 z-[65] flex items-start justify-center bg-app pt-[18vh]"
    >
      <motion.div
        initial={{ opacity: 0, y: 4 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.18, ease: [0.16, 1, 0.3, 1] }}
        className="flex w-[400px] max-w-[calc(100vw-32px)] flex-col"
      >
        <h1 className="mb-5 text-heading text-fg">LLM の接続先</h1>
        <LiteLlmForm onDone={finish} doneLabel="始める" />
        <div className="mt-6 border-t border-line-subtle pt-4">
          <Button
            variant="ghost"
            size="lg"
            className="w-full"
            disabled={!connected || preparing}
            icon={
              preparing ? (
                <Loader2 size={14} className="animate-spin" />
              ) : (
                <Play size={14} strokeWidth={1.75} />
              )
            }
            onClick={tryMock}
          >
            あとで（モックで試す）
          </Button>
        </div>
      </motion.div>
    </div>
  );
}
