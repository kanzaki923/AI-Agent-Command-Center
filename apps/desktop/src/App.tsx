import { MotionConfig, motion } from 'motion/react';
import { useState } from 'react';
import { useStore } from 'zustand';
import { GlobalShortcuts } from './app/GlobalShortcuts';
import { CommandView } from './components/command/CommandView';
import { FocusView } from './components/focus/FocusView';
import { GrantDialog } from './components/grant/Grant';
import { IntegrationView } from './components/integration/IntegrationView';
import { ProjectDialog } from './components/project/ProjectDialog';
import { Onboarding } from './components/onboarding/Onboarding';
import { CommandPalette } from './components/palette/CommandPalette';
import { DetailPanel } from './components/panel/DetailPanel';
import { SettingsDialog } from './components/settings/SettingsDialog';
import { ShortcutsDialog } from './components/settings/ShortcutsDialog';
import { ConfirmDialog } from './components/shell/ConfirmDialog';
import { ReconnectBanner, StartupScreen } from './components/shell/ConnectionStates';
import { Sidebar } from './components/shell/Sidebar';
import { TitleBar } from './components/shell/TitleBar';
import { Toaster } from './components/shell/Toaster';
import { TimelineView } from './components/timeline/TimelineView';
import { TooltipProvider } from './components/ui/Tooltip';
import { useRuntime } from './daemon/runtime';
import { useMediaQuery } from './hooks/useMediaQuery';
import { motionConfigValue } from './lib/theme';
import { useUi } from './store/ui';

function ModeView() {
  const mode = useUi((s) => s.mode);
  const reviewing = useUi((s) => s.reviewIntegrationId);
  if (reviewing) {
    return (
      <div className="min-h-0 flex-1">
        <IntegrationView integrationId={reviewing} />
      </div>
    );
  }
  // Mode switch: a 120ms cross-fade only, no slide (§3.2). Keyed remount = fresh fade-in.
  return (
    <motion.div
      key={mode}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.12, ease: 'linear' }}
      className="min-h-0 flex-1"
    >
      {mode === 'command' ? <CommandView /> : mode === 'focus' ? <FocusView /> : <TimelineView />}
    </motion.div>
  );
}

export function App() {
  const rt = useRuntime();
  const everConnected = useStore(rt.status, (s) => s.everConnected);
  const sidebarOpen = useUi((s) => s.sidebarOpen);
  const reduceMotion = useUi((s) => s.reduceMotion);
  const narrow = !useMediaQuery('(min-width: 900px)');
  const [startedAt] = useState(() => Date.now());

  return (
    <MotionConfig reducedMotion={motionConfigValue(reduceMotion)}>
      <TooltipProvider>
        <div className="flex h-full flex-col bg-app text-fg">
          <TitleBar />
          {everConnected ? (
            <div className="relative flex min-h-0 flex-1">
              {sidebarOpen && !narrow && <Sidebar />}
              <main
                className="relative flex min-w-[480px] flex-1 flex-col overflow-hidden border-t border-l border-line-subtle bg-canvas"
                style={{ borderTopLeftRadius: sidebarOpen && !narrow ? 10 : 0 }}
              >
                <ReconnectBanner />
                <ModeView />
              </main>
              <DetailPanel />
            </div>
          ) : (
            <StartupScreen startedAt={startedAt} />
          )}
        </div>
        <GlobalShortcuts />
        <CommandPalette />
        <SettingsDialog />
        <ShortcutsDialog />
        <ConfirmDialog />
        <GrantDialog />
        <ProjectDialog />
        <Onboarding />
        <Toaster />
      </TooltipProvider>
    </MotionConfig>
  );
}
