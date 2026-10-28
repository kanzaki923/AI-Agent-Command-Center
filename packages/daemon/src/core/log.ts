export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'silent';

const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };

export function parseLogLevel(value: string | undefined, fallback: LogLevel = 'info'): LogLevel {
  return value && value in ORDER ? (value as LogLevel) : fallback;
}

export interface Logger {
  debug(msg: string, data?: Record<string, unknown>): void;
  info(msg: string, data?: Record<string, unknown>): void;
  warn(msg: string, data?: Record<string, unknown>): void;
  error(msg: string, data?: Record<string, unknown>): void;
  child(scope: string): Logger;
}

function format(data: Record<string, unknown> | undefined): string {
  if (!data) return '';
  const parts = Object.entries(data).map(([k, v]) => {
    if (v instanceof Error) return `${k}=${v.stack ?? v.message}`;
    if (typeof v === 'string') return `${k}=${v}`;
    try {
      return `${k}=${JSON.stringify(v)}`;
    } catch {
      return `${k}=[unserializable]`;
    }
  });
  return ' ' + parts.join(' ');
}

/** Small leveled logger writing to stderr. Never log secrets (API keys, tokens). */
export function createLogger(level: LogLevel = 'info', scope = 'daemon'): Logger {
  const min = ORDER[level];
  const write = (lvl: Exclude<LogLevel, 'silent'>, msg: string, data?: Record<string, unknown>) => {
    if (ORDER[lvl] < min) return;
    const line = `${new Date().toISOString()} ${lvl.toUpperCase().padEnd(5)} [${scope}] ${msg}${format(data)}`;
    process.stderr.write(line + '\n');
  };
  return {
    debug: (m, d) => write('debug', m, d),
    info: (m, d) => write('info', m, d),
    warn: (m, d) => write('warn', m, d),
    error: (m, d) => write('error', m, d),
    child: (s) => createLogger(level, `${scope}:${s}`),
  };
}

export const silentLogger: Logger = createLogger('silent');
