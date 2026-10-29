import { spawn } from 'node:child_process';
import { abortError } from '../../async';
import { allowlistedEnv } from '../../env';
import { describeToolActivity } from '../../tools';
import type { StepHandler } from './types';

const OUTPUT_TAIL = 4000;

function quoteArg(a: string): string {
  return /^[\w./:=@-]+$/.test(a) ? a : JSON.stringify(a);
}

/** Run a command without a shell (Bash through the gate). */
export const runStep: StepHandler<'run'> = async function* (ctx, step) {
  const display = [step.command, ...step.args.map(quoteArg)].join(' ');
  const toolInput = { command: display, ...(step.title ? { description: step.title } : {}) };
  const intro = step.title ? `${step.title}ため、コマンドを実行します。` : 'コマンドを実行します。';
  const call = yield* ctx.toolCall(intro, 'Bash', toolInput);

  const permit = await ctx.permit('Bash', toolInput, call);
  if (permit.kind === 'denied') {
    return yield* ctx.denied(call, 'Bash', permit, step.onDeny ?? 'continue');
  }
  if (permit.kind === 'answered' && permit.decision.decision === 'rejected') {
    yield ctx.result(call, 'Bash', '承認されなかったため実行しませんでした', true);
    return yield* ctx.rejected(step.onReject, permit.decision);
  }

  yield { type: 'activity', text: describeToolActivity('Bash', toolInput, ctx.input.cwd) };
  const { code, output } = await execCommand(step.command, step.args, {
    cwd: ctx.input.cwd,
    env: allowlistedEnv(ctx.opts.parentEnv ?? process.env),
    timeoutMs: step.timeoutMs,
    signal: ctx.input.signal,
  });
  const failed = code !== 0;
  const summary = `終了コード: ${code ?? '不明'}${output ? `\n${output}` : ''}`;
  yield ctx.result(call, 'Bash', summary, failed);
  if (failed && !step.allowFailure) {
    yield* ctx.say(`コマンドが失敗しました（終了コード ${code ?? '不明'}）。`);
    throw new Error(`コマンドが失敗しました（終了コード ${code ?? '不明'}）: ${display}`);
  }
  return 'next';
};

/** Run a command without a shell. `node` means this daemon's Node binary. */
export function execCommand(
  command: string,
  args: string[],
  opts: { cwd: string; env: Record<string, string>; timeoutMs: number; signal: AbortSignal },
): Promise<{ code: number | null; output: string }> {
  if (opts.signal.aborted) return Promise.reject(abortError(opts.signal));
  const exe = command === 'node' ? process.execPath : command;
  return new Promise((resolve, reject) => {
    let output = '';
    let settled = false;
    const collect = (chunk: Buffer) => {
      output += chunk.toString('utf8');
      if (output.length > OUTPUT_TAIL * 4) output = output.slice(-OUTPUT_TAIL * 2);
    };
    const child = spawn(exe, args, {
      cwd: opts.cwd,
      env: opts.env,
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);

    const finish = (r: { code: number | null; output: string } | Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      opts.signal.removeEventListener('abort', onAbort);
      if (r instanceof Error) reject(r);
      else resolve(r);
    };
    const tail = () => {
      const t = output.trimEnd();
      return t.length > OUTPUT_TAIL ? `…${t.slice(-OUTPUT_TAIL)}` : t;
    };
    const onAbort = () => {
      child.kill();
      finish(abortError(opts.signal));
    };
    const timer = setTimeout(() => {
      child.kill();
      finish({
        code: null,
        output: `${tail()}\nタイムアウトしました（${opts.timeoutMs}ms）`.trim(),
      });
    }, opts.timeoutMs);
    opts.signal.addEventListener('abort', onAbort, { once: true });

    child.on('error', (err) =>
      finish({ code: null, output: `コマンドを起動できません: ${err.message}` }),
    );
    child.on('close', (code) => finish({ code, output: tail() }));
  });
}
