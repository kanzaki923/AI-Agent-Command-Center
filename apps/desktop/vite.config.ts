import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { type Plugin, defineConfig } from 'vite';

interface DaemonJson {
  port: number;
  token: string;
  pid: number;
}

/**
 * Browser mode (`pnpm dev` without Tauri): hand daemon.json to the page, like the Tauri
 * `get_connection` command does. Only the dev server has this endpoint; production builds
 * never expose the token over HTTP.
 */
function accConnection(): Plugin {
  return {
    name: 'acc-connection',
    configureServer(server) {
      server.middlewares.use('/__acc/connection', (_req, res) => {
        const home = process.env.ACC_HOME || join(homedir(), '.acc');
        readFile(join(home, 'daemon.json'), 'utf8')
          .then((raw) => {
            const info = JSON.parse(raw) as DaemonJson;
            res.setHeader('content-type', 'application/json');
            res.setHeader('cache-control', 'no-store');
            res.end(
              JSON.stringify({
                url: `http://127.0.0.1:${info.port}`,
                wsUrl: `ws://127.0.0.1:${info.port}/ws`,
                token: info.token,
                pid: info.pid,
                spawned: false,
              }),
            );
          })
          .catch(() => {
            res.statusCode = 503;
            res.setHeader('content-type', 'application/json');
            res.end(JSON.stringify({ error: 'daemon_not_running' }));
          });
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), tailwindcss(), accConnection()],
  clearScreen: false, // keep Rust errors visible under `tauri dev`
  server: { port: 5173, strictPort: true, host: '127.0.0.1' },
  envPrefix: ['VITE_', 'TAURI_ENV_'],
  build: {
    target: 'chrome120', // WebView2 is evergreen Chromium
    sourcemap: !!process.env.TAURI_ENV_DEBUG,
    // Loaded from disk by the WebView, not over a network: one chunk is fine.
    chunkSizeWarningLimit: 1600,
  },
});
