import '@fontsource-variable/inter';
import '@fontsource-variable/jetbrains-mono';
import '@fontsource/noto-sans-jp/400.css';
import '@fontsource/noto-sans-jp/500.css';
import '@fontsource/noto-sans-jp/700.css';
import './styles/index.css';

import { createClient } from '@acc/client';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { getConnection } from './daemon/connection';
import { RuntimeProvider, createRuntime, createStatusStore } from './daemon/runtime';
import { installThemeSync } from './lib/theme';
import { useUi } from './store/ui';

installThemeSync(
  () => useUi.getState(),
  (fn) => useUi.subscribe(fn),
);

const status = createStatusStore();
const client = createClient({
  clientName: 'desktop',
  // Re-resolved before every (re)connect: a restarted daemon has a new token.
  connectionInfo: async () => {
    try {
      const c = await getConnection();
      return { url: c.wsUrl, token: c.token };
    } catch (err) {
      status.setState({ lastError: err instanceof Error ? err.message : String(err) });
      throw err;
    }
  },
  reconnect: { initialDelayMs: 300, maxDelayMs: 3000 },
});
const runtime = createRuntime(client, undefined, status);

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <RuntimeProvider runtime={runtime}>
      <App />
    </RuntimeProvider>
  </StrictMode>,
);
