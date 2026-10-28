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

  const existing = readDaemonInfoFile(paths.daemonInfo);
  if (existing && existing.pid !== process.pid && isAlive(existing.pid)) {
    log.error('another daemon is already running for this ACC_HOME', {
      pid: existing.pid,
      port: existing.port,
    });
    process.exitCode = 1;
    return;
  }

  const daemon = await startDaemon({ log });
  log.info('core daemon ready', {
    version: daemon.ctx.version,
    url: daemon.url,
    home: paths.home,
    methods: daemon.ctx.methods.names().length,
  });

  let stopping = false;
  const stop = (signal: string) => {
    if (stopping) return;
    stopping = true;
    log.info('shutting down', { signal });
    daemon.close().then(
      () => process.exit(0),
      (err: unknown) => {
        log.error('shutdown failed', { err });
        process.exit(1);
      },
    );
  };
  process.on('SIGINT', () => stop('SIGINT'));
  process.on('SIGTERM', () => stop('SIGTERM'));
  process.on('SIGHUP', () => stop('SIGHUP'));
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
