import { readFile } from 'node:fs/promises';
import { truncate } from '../../tools';
import { type StepHandler, toPosix } from './types';

/** Read-only verification: the file exists (and contains `contains`). Fails the run otherwise. */
export const checkStep: StepHandler<'check'> = async function* (ctx, step) {
  const { path: relPath, contains } = step;
  const rel = toPosix(relPath);
  const toolName = contains ? 'Grep' : 'Read';
  const toolInput = contains ? { pattern: contains, path: rel } : { file_path: rel };
  const call = yield* ctx.toolCall(`${rel} の内容を確認します。`, toolName, toolInput);
  const permit = await ctx.permit(toolName, toolInput, call);
  if (permit.kind === 'denied') {
    yield ctx.result(call, toolName, permit.message, true);
    throw new Error(`確認できませんでした（規則で拒否）: ${rel}`);
  }
  if (permit.kind === 'answered' && permit.decision.decision === 'rejected') {
    yield ctx.result(call, toolName, '承認されなかったため確認できませんでした', true);
    throw new Error(`確認が承認されませんでした: ${rel}`);
  }
  let text: string | null;
  try {
    text = await readFile(ctx.abs(relPath), 'utf8');
  } catch {
    text = null;
  }
  if (text === null) {
    yield ctx.result(call, toolName, `${rel} が見つかりません`, true);
    throw new Error(`確認に失敗しました: ${rel} が見つかりません`);
  }
  if (contains && !text.includes(contains)) {
    yield ctx.result(call, toolName, `「${contains}」は見つかりませんでした`, true);
    throw new Error(`確認に失敗しました: ${rel} に「${truncate(contains, 40)}」がありません`);
  }
  const lines = text.split('\n').length;
  yield ctx.result(
    call,
    toolName,
    contains
      ? `${rel}: 「${truncate(contains, 40)}」を確認しました`
      : `${rel}（${lines} 行）を確認しました`,
  );
  return 'next';
};
