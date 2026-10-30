import type { SettingsView } from '@acc/protocol';
import { useUi } from '../store/ui';

/** No LLM connection saved yet (LiteLLM, a provider key, a ChatGPT sign-in): requests would run on the mock models. */
export function unconfigured(settings: SettingsView | undefined): boolean {
  if (!settings) return false;
  const p = settings.providers;
  return (
    settings.litellm.baseUrl == null &&
    !settings.litellm.hasApiKey &&
    !p?.anthropic.hasApiKey &&
    !p?.openai.hasApiKey &&
    !p?.openai.chatgpt
  );
}

let pending: (() => void) | null = null;

/**
 * The first real request before any connection is set up (ui-rework spec §3.4): ask for the
 * endpoint right there, once. `go` runs when the prompt closes, whichever way (connected or
 * あとで, which keeps the mock). Returns false when no prompt was needed (the caller goes on).
 */
export function promptConnectionThen(settings: SettingsView | undefined, go: () => void): boolean {
  const ui = useUi.getState();
  if (ui.onboardingDone || !unconfigured(settings)) return false;
  pending = go;
  ui.setConnectPromptOpen(true);
  return true;
}

/** The prompt closed: run what was waiting on it. */
export function connectionPromptClosed(): void {
  const go = pending;
  pending = null;
  useUi.getState().finishOnboarding();
  go?.();
}
