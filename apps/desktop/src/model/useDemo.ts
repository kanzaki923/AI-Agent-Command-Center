import { useModels, useSettings } from '../daemon/queries';

/**
 * Demo mode = no LiteLLM endpoint configured, so the daemon answers with its built-in mock
 * provider (no cost). Derived from daemon state rather than stored in the UI.
 */
export function useIsDemo(): boolean {
  const settings = useSettings();
  const models = useModels();
  if (models.data?.source === 'mock') return true;
  if (!settings.data) return false;
  return settings.data.litellm.baseUrl == null;
}
