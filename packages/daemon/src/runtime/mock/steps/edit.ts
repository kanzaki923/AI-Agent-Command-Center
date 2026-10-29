import { existsSync } from 'node:fs';
import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { AgentEvent } from '../../../contracts';
import type { DenyAction } from '../plan';
import { type StepContext, type StepHandler, type StepOutcome, toPosix } from './types';

/** Write or append a workspace file (Write / Edit through the gate). Also used by `resolve`. */
export async function* editFile(
  ctx: StepContext,
  kind: 'write' | 'append',
  relPath: string,
  content: string,
  onDeny: DenyAction = 'continue',
): AsyncGenerator<AgentEvent, StepOutcome, undefined> {
  const rel = toPosix(relPath);
  const exists = existsSync(ctx.abs(relPath));
  const toolName = kind === 'write' ? 'Write' : 'Edit';
  const toolInput =
    kind === 'write' ? { file_path: rel, content } : { file_path: rel, append: content };
  const verb = kind === 'append' ? '追記' : exists ? '書き換え' : '作成';
  const call = yield* ctx.toolCall(`${rel} を${verb}します。`, toolName, toolInput);

  const permit = await ctx.permit(toolName, toolInput, call);
  if (permit.kind === 'denied') return yield* ctx.denied(call, toolName, permit, onDeny);
  if (permit.kind === 'answered' && permit.decision.decision === 'rejected') {
    yield ctx.result(call, toolName, '承認されなかったため変更しませんでした', true);
    return yield* ctx.rejected('stop', permit.decision);
  }

  const abs = ctx.abs(relPath);
  await mkdir(path.dirname(abs), { recursive: true });
  if (kind === 'write') await writeFile(abs, content, 'utf8');
  else await appendFile(abs, content, 'utf8');
  if (!ctx.changed.has(rel)) ctx.changed.set(rel, exists ? 'updated' : 'created');
  const lines = content.split('\n').length - (content.endsWith('\n') ? 1 : 0);
  yield ctx.result(
    call,
    toolName,
    kind === 'write'
      ? `${rel} に ${lines} 行を書き込みました`
      : `${rel} に ${lines} 行を追記しました`,
  );
  return 'next';
}

export const writeStep: StepHandler<'write'> = (ctx, step) =>
  editFile(ctx, 'write', step.path, step.content, step.onDeny);

export const appendStep: StepHandler<'append'> = (ctx, step) =>
  editFile(ctx, 'append', step.path, step.content, step.onDeny);
