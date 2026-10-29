import type { StepHandler } from './types';

/** Tool name of artifact.publish as Claude's in-process MCP server "acc" names it. */
const TOOL = 'mcp__acc__artifact_publish';

/**
 * Publish an output with the `artifact.publish` Control API tool (spec 20261029 §3.12, T3).
 * Like a real agent it can only use the tools its run's grant offers; a refusal (no tool,
 * invalid params, a path outside the workspace) comes back as the tool's error and the plan
 * goes on.
 */
export const publishStep: StepHandler<'publish'> = async function* (ctx, step) {
  const { type: _type, ...params } = step;
  const call = yield* ctx.toolCall(`「${step.title}」を成果物として残します。`, TOOL, params);
  const permit = await ctx.permit(TOOL, params, call);
  if (permit.kind === 'denied') return yield* ctx.denied(call, TOOL, permit, 'continue');
  if (permit.kind === 'answered' && permit.decision.decision === 'rejected') {
    yield ctx.result(call, TOOL, '承認されなかったため公開しませんでした', true);
    return yield* ctx.rejected('continue', permit.decision);
  }
  const tool = ctx.input.tools?.find((t) => t.method === 'artifact.publish');
  if (!tool) {
    yield ctx.result(
      call,
      TOOL,
      'この実行には成果物を公開する権限（artifact.publish）がありません',
      true,
    );
    return 'next';
  }
  try {
    const artifact = (await tool.execute(params, { signal: ctx.input.signal })) as {
      id?: string;
      kind?: string;
    };
    yield ctx.result(call, TOOL, `成果物を公開しました（${artifact.kind ?? step.kind}）`);
  } catch (err) {
    yield ctx.result(call, TOOL, (err as Error).message, true);
  }
  return 'next';
};
