/**
 * Worker read access to the Control API for the Claude runtime: an in-process MCP server
 * "acc" built from the tools the run's grant allows. Tested without spawning the CLI: the
 * real SDK `tool` / `createSdkMcpServer` (in-process) and a fake `query`.
 */
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { Settings } from '@acc/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import type { AgentTool } from '../contracts';
import { apiTools } from '../llm/tools';
import {
  HUMAN,
  type TestDaemonNoServer,
  agentActor,
  createTestDaemon,
  insertTestTask,
} from '../testing';
import { ACC_MCP_SERVER, accMcpServer, buildAccMcpTools, qualifiedMcpToolName } from './claude/mcp';
import { ClaudeAgentSdkRuntime, type ClaudeSdkModule, type QueryFn } from './claude/runtime';
import { decideToolPermission } from './policy';

let d: TestDaemonNoServer | undefined;
afterEach(async () => {
  await d?.cleanup();
  d = undefined;
});

const sdk = { tool, createSdkMcpServer };

/** A worker run holding the default read-only worker grant for one project. */
async function workerWithGrant() {
  d = await createTestDaemon();
  d.ctx
    .service('runs')
    .registerExecutor(
      'agent',
      (ctl) => new Promise((r) => ctl.signal.addEventListener('abort', () => r())),
    );
  const p1 = await d.call(HUMAN, 'project.create', { name: 'p1' });
  const p2 = await d.call(HUMAN, 'project.create', { name: 'p2' });
  const session = await d.call(HUMAN, 'session.create', { kind: 'agent', projectId: p1.id });
  const run = d.ctx
    .service('runs')
    .start({ sessionId: session.id, kind: 'agent', createdBy: HUMAN });
  d.ctx.service('policy').createGrant(
    {
      subject: { kind: 'run', runId: run.id },
      permissions: ['task.get', 'workspace.get', 'workspace.diff', 'artifact.list', 'artifact.get'],
      scope: { projectIds: [p1.id] },
      limits: { maxWorkers: 0, maxDepth: 0 },
      lifetime: 'run',
      reason: 'worker',
    },
    HUMAN,
  );
  const actor = agentActor(session.id, run.id);
  const tools: AgentTool[] = apiTools(d.ctx, actor).map((t) => ({
    method: t.method!,
    description: t.description,
    execute: (i, o) => t.execute(i, o),
  }));
  return { d, p1, p2, actor, tools };
}

type Handler = (
  args: unknown,
  extra: unknown,
) => Promise<{ content: { text: string }[]; isError?: boolean }>;

describe('acc MCP server for the Claude runtime', () => {
  it('maps exactly the granted methods to MCP tools that call the dispatcher as the worker', async () => {
    const { d, p1, p2, tools } = await workerWithGrant();
    expect(tools.map((t) => t.method).sort()).toEqual([
      'artifact.get',
      'artifact.list',
      'task.get',
      'workspace.diff',
      'workspace.get',
    ]);
    const defs = buildAccMcpTools(sdk, tools, new AbortController().signal);
    expect(defs.map((t) => t.name).sort()).toEqual([
      'artifact_get',
      'artifact_list',
      'task_get',
      'workspace_diff',
      'workspace_get',
    ]);
    const taskGet = defs.find((t) => t.name === 'task_get')!;
    // The params schema of the contract is the input schema.
    expect(Object.keys(taskGet.inputSchema)).toEqual(['taskId']);

    const mine = insertTestTask(d.ctx, { projectId: p1.id, title: 'mine' });
    const other = insertTestTask(d.ctx, { projectId: p2.id, title: 'other' });
    const call = taskGet.handler as unknown as Handler;
    const ok = await call({ taskId: mine.id }, {});
    expect(ok.isError).toBeFalsy();
    expect(JSON.parse(ok.content[0]!.text)).toMatchObject({ id: mine.id, title: 'mine' });
    // Outside the grant's project: refused by the dispatcher, returned as a tool error.
    const denied = await call({ taskId: other.id }, {});
    expect(denied.isError).toBe(true);
    expect(JSON.parse(denied.content[0]!.text)).toMatchObject({ error: { code: 'forbidden' } });
    expect(
      d.ctx.bus
        .list({ types: ['policy.denied'] })
        .events.map((e) => (e.type === 'policy.denied' ? e.payload.permission : null)),
    ).toEqual(['task.get']);
  });

  it('the runtime passes the server and its allowed tool names to query(); no tools, no server', async () => {
    const { tools } = await workerWithGrant();
    const seen: Parameters<QueryFn>[0]['options'][] = [];
    const query: QueryFn = ({ prompt, options }) => {
      seen.push(options);
      return {
        async interrupt() {},
        close() {},
        async *[Symbol.asyncIterator]() {
          await prompt[Symbol.asyncIterator]().next();
          yield { type: 'system', subtype: 'init', session_id: 's1', model: 'm', tools: [] };
          yield {
            type: 'result',
            subtype: 'success',
            is_error: false,
            session_id: 's1',
            result: 'done',
            total_cost_usd: 0,
            usage: { input_tokens: 1, output_tokens: 1 },
            modelUsage: {},
          };
        },
      };
    };
    const module: ClaudeSdkModule = { query, ...sdk };
    const rt = new ClaudeAgentSdkRuntime({
      settings: () => Settings.parse({}),
      loadSdk: async () => module,
    });
    const run = (withTools: boolean) =>
      (async () => {
        for await (const _ of rt.run({
          runId: 'run_1',
          cwd: process.cwd(),
          prompt: 'x',
          signal: new AbortController().signal,
          canUseTool: async () => ({ decision: 'approved' }),
          ...(withTools ? { tools } : {}),
        }));
      })();
    await run(true);
    await run(false);

    const [withTools, without] = seen as [(typeof seen)[0], (typeof seen)[0]];
    expect(Object.keys(withTools.mcpServers ?? {})).toEqual([ACC_MCP_SERVER]);
    expect(withTools.allowedTools?.sort()).toEqual(
      tools.map((t) => qualifiedMcpToolName(t.method)).sort(),
    );
    expect(withTools.allowedTools).toContain('mcp__acc__task_get');
    expect(without.mcpServers).toBeUndefined();
    expect(without.allowedTools).toBeUndefined();
    expect(accMcpServer(sdk, [], new AbortController().signal)).toBeNull();
    // The daemon's own tool policy lets these through without an approval as well.
    expect(
      decideToolPermission({ toolName: 'mcp__acc__task_get', input: {}, cwd: process.cwd() })
        .decision,
    ).toBe('allow');
  });
});
