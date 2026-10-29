import { readFile } from 'node:fs/promises';
import { conflictedFiles } from '../../../workspace/git';
import { resolveConflictMarkers } from '../plan';
import { editFile } from './edit';
import { type StepHandler, toPosix } from './types';

/** Rewrite every conflicted file without markers (Read, then Write — both in the workspace). */
export const resolveStep: StepHandler<'resolve'> = async function* (ctx, step) {
  const { strategy } = step;
  const files = step.paths ?? (await conflictedFiles(ctx.input.cwd).catch(() => []));
  if (files.length === 0) {
    yield* ctx.say('解消が必要なコンフリクトは見つかりませんでした。');
    return 'next';
  }
  const how =
    strategy === 'ours+theirs'
      ? '両方の変更を残す形'
      : strategy === 'ours'
        ? '統合ブランチ側を残す形'
        : 'マージする側を残す形';
  yield* ctx.say(`${files.length} ファイルのコンフリクトを、${how}で解消します。`);
  for (const f of files) {
    const rel = toPosix(f);
    const readInput = { file_path: rel };
    const call = yield* ctx.toolCall(`${rel} のコンフリクトを確認します。`, 'Read', readInput);
    const permit = await ctx.permit('Read', readInput, call);
    if (permit.kind === 'denied') return yield* ctx.denied(call, 'Read', permit, 'stop');
    if (permit.kind === 'answered' && permit.decision.decision === 'rejected') {
      yield ctx.result(call, 'Read', '承認されなかったため確認できませんでした', true);
      return yield* ctx.rejected('stop', permit.decision);
    }
    let text: string;
    try {
      text = await readFile(ctx.abs(f), 'utf8');
    } catch {
      yield ctx.result(call, 'Read', `${rel} が見つかりません`, true);
      continue;
    }
    const resolved = resolveConflictMarkers(text, strategy);
    yield ctx.result(call, 'Read', `${rel}: コンフリクト ${resolved.hunks} 箇所`);
    if (resolved.hunks === 0) continue;
    const outcome = yield* editFile(ctx, 'write', f, resolved.text);
    if (outcome === 'stop') return 'stop';
  }
  return 'next';
};
