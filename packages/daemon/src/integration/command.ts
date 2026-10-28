import { spawn } from 'node:child_process';
import { allowlistedEnv } from '../runtime/env';

export interface CommandResult {
  exitCode: number | null;
  /** True when the command was killed for exceeding the timeout. */
  timedOut: boolean;
  /** True when the command was killed because the signal aborted. */
  aborted: boolean;
  durationMs: number;
  /** Last `maxOutputBytes` of combined stdout+stderr. */
  output: string;
  outputTruncated: boolean;
}

export interface CommandOptions {
  cwd: string;
  timeoutMs: number;
  maxOutputBytes: number;
  signal?: AbortSignal;
  env?: NodeJS.ProcessEnv;
}

/**
 * Environment for project commands, which run code agents wrote: the same allowlist as agent
 * processes (`runtime/env.ts`), never the daemon's whole environment with the LiteLLM key and
 * the user's cloud tokens. CI=true so test runners never enter watch mode or wait for input.
 */
export function commandEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return { ...allowlistedEnv(base), CI: 'true' };
}

/** Replace every occurrence of the given secrets (e.g. keys a test printed) with a marker. */
export function redactSecrets(
  text: string,
  secrets: readonly (string | null | undefined)[],
): string {
  let out = text;
  for (const s of secrets) {
    // Short values would redact ordinary words; real keys and tokens are long.
    if (s && s.length >= 8) out = out.split(s).join('[REDACTED]');
  }
  return out;
}

/** Kill a process and everything it spawned (shell + test runner + workers). */
function killTree(pid: number): void {
  if (process.platform === 'win32') {
    const k = spawn('taskkill', ['/pid', String(pid), '/T', '/F'], {
      stdio: 'ignore',
      windowsHide: true,
    });
    k.on('error', () => undefined);
  } else {
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        // already gone
      }
    }
  }
}

/**
 * Run a user-configured shell command (e.g. "pnpm test") asynchronously, keeping only the
 * tail of its output. Never rejects for a failing command; inspect `exitCode`.
 */
export function runShellCommand(command: string, opts: CommandOptions): Promise<CommandResult> {
  const started = Date.now();
  return new Promise((resolve) => {
    const child = spawn(command, {
      cwd: opts.cwd,
      shell: true,
      env: opts.env ?? commandEnv(),
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      // Own process group on POSIX so the whole tree can be killed.
      detached: process.platform !== 'win32',
    });

    const chunks: Buffer[] = [];
    let size = 0;
    let truncated = false;
    const onData = (c: Buffer) => {
      chunks.push(c);
      size += c.length;
      while (size > opts.maxOutputBytes && chunks.length > 1) {
        size -= chunks.shift()!.length;
        truncated = true;
      }
      if (size > opts.maxOutputBytes && chunks.length === 1) {
        const only = chunks[0]!;
        chunks[0] = only.subarray(only.length - opts.maxOutputBytes);
        size = chunks[0].length;
        truncated = true;
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);

    let timedOut = false;
    let aborted = false;
    let settled = false;
    const stop = () => {
      if (child.pid !== undefined) killTree(child.pid);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      stop();
    }, opts.timeoutMs);
    const onAbort = () => {
      aborted = true;
      stop();
    };
    if (opts.signal?.aborted) onAbort();
    else opts.signal?.addEventListener('abort', onAbort, { once: true });

    const finish = (exitCode: number | null, extra?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
      let output = Buffer.concat(chunks).toString('utf8');
      if (truncated) output = output.replace(/^[\s\S]*?\n/, ''); // drop the partial first line
      if (extra) output += extra;
      resolve({
        exitCode,
        timedOut,
        aborted,
        durationMs: Date.now() - started,
        output,
        outputTruncated: truncated,
      });
    };
    child.on('error', (err) => finish(null, `\n${err.message}\n`));
    child.on('close', (code) => finish(code));
  });
}
