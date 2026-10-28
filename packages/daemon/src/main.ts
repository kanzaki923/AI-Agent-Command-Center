/**
 * Core Daemon entry point: `pnpm dev:daemon` (tsx watch) or `pnpm start:daemon`.
 *
 * Env: ACC_HOME (data dir, default ~/.acc), ACC_PORT (default 47821), ACC_LOG_LEVEL
 * (debug|info|warn|error), ACC_LITELLM_BASE_URL / ACC_LITELLM_API_KEY (override config.json).
 */

// node:sqlite prints an ExperimentalWarning on load; it is expected, so hide just that one.
const originalEmitWarning = process.emitWarning.bind(process);
process.emitWarning = (warning: string | Error, ...rest: unknown[]) => {
  const msg = typeof warning === 'string' ? warning : warning.message;
  if (msg.includes('SQLite is an experimental feature')) return;
  (originalEmitWarning as (...a: unknown[]) => void)(warning, ...rest);
};

async function main(): Promise<void> {
  // Imported after the warning filter is installed.
  const { startDaemon, readDaemonInfoFile } = await import('./daemon');
  const { resolvePaths } = await import('./core/config');
  const { createLogger, parseLogLevel } = await import('./core/log');

  const log = createLogger(parseLogLevel(process.env.ACC_LOG_LEVEL));
  const paths = resolvePaths();

  // Exit 0 when another daemon already serves this ACC_HOME: launchers (the desktop shell,
  // `pnpm dev:desktop`) treat exit 0 as "someone else owns it" and connect to the winner.
  const existing = readDaemonInfoFile(paths.daemonInfo);
  if (existing && existing.pid !== process.pid && isAlive(existing.pid)) {
    log.warn('another daemon is already running for this ACC_HOME; leaving it in charge', {
      pid: existing.pid,
      port: existing.port,
    });
    return;
  }

  let daemon: Awaited<ReturnType<typeof startDaemon>>;
  try {
    daemon = await startDaemon({ log });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw err;
    // Lost a start race (UI and CLI at once): the winner writes daemon.json right after
    // it binds. Anything else on the port is a real conflict.
    const winner = await waitFor(() => {
      const info = readDaemonInfoFile(paths.daemonInfo);
      return info && info.pid !== process.pid && isAlive(info.pid) ? info : null;
    }, 3000);
    if (winner) {
      log.warn('port taken by another daemon for this ACC_HOME; leaving it in charge', {
        pid: winner.pid,
        port: winner.port,
      });
      return;
    }
    log.error('port is in use by another program (set ACC_PORT to use another port)', {
      err,
    });
    process.exitCode = 1;
    return;
  }
  log.info('core daemon ready', {
    version: daemon.ctx.version,
    url: daemon.url,
    home: paths.home,
    methods: daemon.ctx.methods.names().length,
  });

  // One exit path for signals and `system.shutdown` (which closes the daemon from inside).
  daemon.closed.then(
    () => process.exit(0),
    () => process.exit(1),
  );
  const stop = (signal: string) => {
    log.info('shutting down', { signal });
    daemon.close().catch((err: unknown) => {
      log.error('shutdown failed', { err });
      process.exit(1);
    });
  };
  process.on('SIGINT', () => stop('SIGINT'));
  process.on('SIGTERM', () => stop('SIGTERM'));
  process.on('SIGHUP', () => stop('SIGHUP'));
  // Windows: Ctrl+Break / closing the console window.
  process.on('SIGBREAK', () => stop('SIGBREAK'));
}

async function waitFor<T>(probe: () => T | null, timeoutMs: number): Promise<T | null> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = probe();
    if (v || Date.now() >= deadline) return v;
    await new Promise((r) => setTimeout(r, 100));
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
