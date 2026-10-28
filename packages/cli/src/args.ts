import { parseArgs as nodeParseArgs } from 'node:util';

export interface EventsFilterArgs {
  projectId?: string;
  sessionId?: string;
  runId?: string;
  taskId?: string;
  types?: string[];
}

export type Command =
  | { kind: 'help'; topic?: string }
  | { kind: 'version' }
  | { kind: 'status'; json: boolean }
  | { kind: 'sessions'; json: boolean; projectId?: string; all: boolean; limit: number }
  | {
      kind: 'events';
      json: boolean;
      follow: boolean;
      since?: number;
      limit: number;
      filter: EventsFilterArgs;
    };

export type ParseResult = { ok: true; command: Command } | { ok: false; error: string };

const COMMANDS = ['status', 'sessions', 'events', 'help'] as const;

function int(name: string, v: string | undefined, min: number, max: number): number | string {
  if (v === undefined) return `--${name} に値がありません`;
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) {
    return `--${name} は ${min}〜${max} の整数で指定してください: ${v}`;
  }
  return n;
}

/** Parse `acc` arguments (without the node/script prefix). Pure: no I/O. */
export function parseArgs(argv: readonly string[]): ParseResult {
  const [first, ...rest] = argv;
  if (first === undefined || first === 'help' || first === '--help' || first === '-h') {
    return { ok: true, command: { kind: 'help', ...(rest[0] ? { topic: rest[0] } : {}) } };
  }
  if (first === '--version' || first === '-v') return { ok: true, command: { kind: 'version' } };
  if (!(COMMANDS as readonly string[]).includes(first)) {
    return { ok: false, error: `不明なコマンドです: ${first}（acc help で一覧を表示）` };
  }

  try {
    switch (first) {
      case 'status': {
        const { values } = nodeParseArgs({
          args: rest,
          options: {
            json: { type: 'boolean', default: false },
            help: { type: 'boolean', short: 'h' },
          },
          strict: true,
        });
        if (values.help) return { ok: true, command: { kind: 'help', topic: 'status' } };
        return { ok: true, command: { kind: 'status', json: values.json } };
      }
      case 'sessions': {
        const { values } = nodeParseArgs({
          args: rest,
          options: {
            json: { type: 'boolean', default: false },
            project: { type: 'string', short: 'p' },
            all: { type: 'boolean', short: 'a', default: false },
            limit: { type: 'string', short: 'n' },
            help: { type: 'boolean', short: 'h' },
          },
          strict: true,
        });
        if (values.help) return { ok: true, command: { kind: 'help', topic: 'sessions' } };
        const limit = values.limit === undefined ? 30 : int('limit', values.limit, 1, 200);
        if (typeof limit === 'string') return { ok: false, error: limit };
        return {
          ok: true,
          command: {
            kind: 'sessions',
            json: values.json,
            all: values.all,
            limit,
            ...(values.project ? { projectId: values.project } : {}),
          },
        };
      }
      case 'events': {
        const { values } = nodeParseArgs({
          args: rest,
          options: {
            json: { type: 'boolean', default: false },
            follow: { type: 'boolean', short: 'f', default: false },
            since: { type: 'string' },
            limit: { type: 'string', short: 'n' },
            type: { type: 'string', short: 't', multiple: true },
            project: { type: 'string' },
            session: { type: 'string' },
            run: { type: 'string' },
            task: { type: 'string' },
            help: { type: 'boolean', short: 'h' },
          },
          strict: true,
        });
        if (values.help) return { ok: true, command: { kind: 'help', topic: 'events' } };
        const limit = values.limit === undefined ? 50 : int('limit', values.limit, 1, 1000);
        if (typeof limit === 'string') return { ok: false, error: limit };
        let since: number | undefined;
        if (values.since !== undefined) {
          const s = int('since', values.since, 0, Number.MAX_SAFE_INTEGER);
          if (typeof s === 'string') return { ok: false, error: s };
          since = s;
        }
        const filter: EventsFilterArgs = {};
        if (values.project) filter.projectId = values.project;
        if (values.session) filter.sessionId = values.session;
        if (values.run) filter.runId = values.run;
        if (values.task) filter.taskId = values.task;
        if (values.type?.length)
          filter.types = values.type.flatMap((t) => t.split(',')).filter(Boolean);
        return {
          ok: true,
          command: {
            kind: 'events',
            json: values.json,
            follow: values.follow,
            limit,
            filter,
            ...(since !== undefined ? { since } : {}),
          },
        };
      }
      default:
        return { ok: true, command: { kind: 'help' } };
    }
  } catch (err) {
    return { ok: false, error: translateParseError(err) };
  }
}

function translateParseError(err: unknown): string {
  const e = err as { code?: string; message?: string };
  const m = e.message ?? String(err);
  if (e.code === 'ERR_PARSE_ARGS_UNKNOWN_OPTION') {
    const opt = /'([^']+)'/.exec(m)?.[1] ?? m;
    return `不明なオプションです: ${opt}`;
  }
  if (e.code === 'ERR_PARSE_ARGS_INVALID_OPTION_VALUE') return `オプションの値が不正です: ${m}`;
  if (e.code === 'ERR_PARSE_ARGS_UNEXPECTED_POSITIONAL') {
    const arg = /'([^']+)'/.exec(m)?.[1] ?? m;
    return `余分な引数があります: ${arg}`;
  }
  return m;
}

export const HELP: Record<string, string> = {
  main: `acc — AI Agent Command Center CLI

使い方:
  acc status [--json]                 Core Daemon の状態を表示
  acc sessions [-p <projectId>] [-a] [-n <件数>] [--json]
                                      セッション一覧（最近の活動順）
  acc events [-f] [-n <件数>] [--since <seq>] [-t <type>]...
             [--project|--session|--run|--task <id>] [--json]
                                      イベントを表示（-f で追従）
  acc help [コマンド]                 ヘルプ

接続先は $ACC_HOME/daemon.json（既定 ~/.acc）から読み取ります。`,
  status: `acc status [--json]
  Core Daemon のバージョン・ポート・稼働時間・件数を表示します。`,
  sessions: `acc sessions [-p, --project <projectId>] [-a, --all] [-n, --limit <1-200>] [--json]
  -a  アーカイブ済みも含める`,
  events: `acc events [-f, --follow] [-n, --limit <1-1000>] [--since <seq>] [-t, --type <type>]...
           [--project <id>] [--session <id>] [--run <id>] [--task <id>] [--json]
  -f  新しいイベントを追従表示（Ctrl+C で終了）
  -t  "run.*" のようなパターンも可。カンマ区切りまたは複数回指定`,
};
