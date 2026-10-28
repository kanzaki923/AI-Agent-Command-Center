import { type AccClient, AccClientError, createClient } from '@acc/client';
import {
  connectionInfoFrom,
  daemonInfoPath,
  readDaemonInfo,
  resolveAccHome,
} from '@acc/client/node';
import type { Event } from '@acc/protocol';
import { type Command, HELP, parseArgs } from './args';
import { formatEvent, formatSession, formatStatus } from './format';

export const CLI_VERSION = '0.1.0';

export interface Io {
  out(line: string): void;
  err(line: string): void;
  env: NodeJS.ProcessEnv;
  /** Resolves when the user interrupts (Ctrl+C) — ends `events --follow`. */
  interrupted: Promise<void>;
  /** Whether a process is still running (`daemon stop` waits for the exit). */
  isProcessAlive?: (pid: number) => boolean;
}

export function processIo(): Io {
  return {
    out: (l) => process.stdout.write(l + '\n'),
    err: (l) => process.stderr.write(l + '\n'),
    env: process.env,
    interrupted: new Promise((resolve) => process.once('SIGINT', () => resolve())),
  };
}

/** Entry point; returns the exit code. */
export async function run(argv: readonly string[], io: Io = processIo()): Promise<number> {
  const parsed = parseArgs(argv);
  if (!parsed.ok) {
    io.err(`エラー: ${parsed.error}`);
    return 2;
  }
  const cmd = parsed.command;
  if (cmd.kind === 'help') {
    io.out(HELP[cmd.topic ?? 'main'] ?? HELP.main!);
    return 0;
  }
  if (cmd.kind === 'version') {
    io.out(CLI_VERSION);
    return 0;
  }

  const home = resolveAccHome(io.env);
  const info = readDaemonInfo(home);
  if (!info) {
    if (cmd.kind === 'daemon-stop') {
      io.out('Core Daemon は起動していません。');
      return 0;
    }
    io.err(`Core Daemon が起動していません（${daemonInfoPath(home)} が見つかりません）。`);
    io.err('デスクトップアプリを開くか、`pnpm dev:daemon` で起動してください。');
    return 1;
  }

  const client = createClient({ ...connectionInfoFrom(info), clientName: 'cli', reconnect: false });
  try {
    await client.ready();
  } catch {
    io.err(`Core Daemon（ポート ${info.port}）に接続できません。停止している可能性があります。`);
    return 1;
  }
  try {
    return await execute(cmd, client, io);
  } catch (err) {
    if (err instanceof AccClientError) io.err(`エラー [${err.code}]: ${err.message}`);
    else io.err(`エラー: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  } finally {
    client.close();
  }
}

async function execute(
  cmd: Exclude<Command, { kind: 'help' | 'version' }>,
  client: AccClient,
  io: Io,
) {
  switch (cmd.kind) {
    case 'status': {
      const [info, health] = await Promise.all([
        client.call('system.info'),
        client.call('system.health'),
      ]);
      io.out(cmd.json ? JSON.stringify(info, null, 2) : formatStatus(info, health.uptimeMs));
      return 0;
    }
    case 'sessions': {
      const page = await client.call('session.list', {
        limit: cmd.limit,
        includeArchived: cmd.all,
        ...(cmd.projectId ? { projectId: cmd.projectId } : {}),
      });
      if (cmd.json) {
        io.out(JSON.stringify(page.items, null, 2));
      } else if (page.items.length === 0) {
        io.out('セッションはまだありません。');
      } else {
        for (const s of page.items) io.out(formatSession(s));
        if (page.nextCursor) io.out(`… さらにあります（-n で件数を増やせます）`);
      }
      return 0;
    }
    case 'events':
      return events(cmd, client, io);
    case 'daemon-stop':
      return stopDaemon(cmd, client, io);
  }
}

const STOP_TIMEOUT_MS = 15_000;

async function stopDaemon(
  cmd: Extract<Command, { kind: 'daemon-stop' }>,
  client: AccClient,
  io: Io,
): Promise<number> {
  let res;
  try {
    res = await client.call('system.shutdown', { force: cmd.force });
  } catch (err) {
    if (err instanceof AccClientError && err.code === 'conflict') {
      io.err(err.message);
      io.err('実行中の Run を中断して停止するには `acc daemon stop --force` を実行してください。');
      return 1;
    }
    throw err;
  }
  client.close();
  const alive = io.isProcessAlive ?? isProcessAlive;
  const deadline = Date.now() + STOP_TIMEOUT_MS;
  while (alive(res.pid)) {
    if (Date.now() >= deadline) {
      io.err(`停止を要求しましたが、Core Daemon（pid ${res.pid}）がまだ終了していません。`);
      return 1;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  const interrupted =
    res.activeRuns > 0 ? `。実行中だった Run ${res.activeRuns} 件は中断しました` : '';
  io.out(`Core Daemon を停止しました（pid ${res.pid}）${interrupted}。`);
  return 0;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

async function events(cmd: Extract<Command, { kind: 'events' }>, client: AccClient, io: Io) {
  const print = (e: Event) => io.out(cmd.json ? JSON.stringify(e) : formatEvent(e));
  let since = cmd.since;
  if (since === undefined) {
    const head = (await client.call('system.info')).stats.lastEventSeq;
    since = Math.max(0, head - cmd.limit);
  }
  const page = await client.call('events.list', { ...cmd.filter, since, limit: cmd.limit });
  for (const e of page.events) print(e);
  if (!cmd.follow) {
    if (page.events.length === 0 && !cmd.json) io.out('該当するイベントはありません。');
    return 0;
  }

  // Follow: resume right after what we printed; the client de-duplicates by seq.
  const status: { failed: Error | null } = { failed: null };
  const sub = client.subscribe({
    ...cmd.filter,
    since: page.lastSeq,
    onEvent: print,
    onError: (err) => {
      status.failed = err instanceof Error ? err : new Error(String(err));
    },
  });
  const lost = new Promise<void>((resolve) => {
    client.onStateChange((s) => {
      if (s === 'closed' || s === 'reconnecting') resolve();
    });
  });
  await Promise.race([io.interrupted, lost]);
  sub.unsubscribe();
  if (status.failed) throw status.failed;
  if (client.state !== 'open') {
    io.err('Core Daemon との接続が切れました。');
    return 1;
  }
  return 0;
}
