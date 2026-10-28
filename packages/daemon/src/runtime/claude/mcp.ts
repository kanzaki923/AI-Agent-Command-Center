import type {
  McpSdkServerConfigWithInstance,
  SdkMcpToolDefinition,
  createSdkMcpServer,
  tool,
} from '@anthropic-ai/claude-agent-sdk';
import { api } from '@acc/protocol';
import { z } from 'zod';
import type { AgentTool } from '../../contracts';
import { ApiError } from '../../core/errors';
import { stringifyToolOutput } from '../../llm/messages';

/** Name of the in-process MCP server; the CLI shows its tools as `mcp__acc__<tool>`. */
export const ACC_MCP_SERVER = 'acc';

/** The SDK functions this needs (injected in tests, so no CLI is spawned). */
export interface McpSdk {
  tool: typeof tool;
  createSdkMcpServer: typeof createSdkMcpServer;
}

/** MCP tool name of a Control API method: "task.get" → "task_get" (methods have no "_"). */
export function mcpToolName(method: string): string {
  return method.replaceAll('.', '_');
}

/** Fully qualified name the CLI uses for permission checks and `allowedTools`. */
export function qualifiedMcpToolName(method: string): string {
  return `mcp__${ACC_MCP_SERVER}__${mcpToolName(method)}`;
}

/**
 * MCP tool definitions for the Control API methods a run may call (`AgentRunInput.tools`,
 * already narrowed to the run's grant). The input schema is the method's own params schema
 * from the contract; each call goes through `AgentTool.execute` (= `ctx.call` as the run's
 * agent actor), so the dispatcher validates params and enforces grants exactly as for any
 * other caller. Errors come back as `isError` results instead of failing the run.
 */
export function buildAccMcpTools(
  sdk: Pick<McpSdk, 'tool'>,
  tools: readonly AgentTool[],
  signal: AbortSignal,
): SdkMcpToolDefinition[] {
  return tools.map((t) => {
    const params = api[t.method].params;
    const shape = params instanceof z.ZodObject ? params.shape : {};
    return sdk.tool(mcpToolName(t.method), t.description, shape, async (args) => {
      try {
        const out = await t.execute(args, { signal });
        return { content: [{ type: 'text', text: stringifyToolOutput(out) }] };
      } catch (err) {
        const error =
          err instanceof ApiError
            ? { code: err.code, message: err.message }
            : { code: 'internal', message: err instanceof Error ? err.message : String(err) };
        return {
          content: [{ type: 'text', text: JSON.stringify({ error }) }],
          isError: true,
        };
      }
    });
  });
}

/**
 * The `mcpServers` entry and `allowedTools` for a run, or null when it has no tools (e.g. a
 * worker a human started without a grant). Listing them in `allowedTools` keeps the CLI from
 * asking for each call; the capability check happens in the dispatcher instead.
 */
export function accMcpServer(
  sdk: McpSdk,
  tools: readonly AgentTool[] | undefined,
  signal: AbortSignal,
  version = '0.1.0',
): { server: McpSdkServerConfigWithInstance; allowedTools: string[] } | null {
  if (!tools?.length) return null;
  const server = sdk.createSdkMcpServer({
    name: ACC_MCP_SERVER,
    version,
    tools: buildAccMcpTools(sdk, tools, signal),
  });
  return { server, allowedTools: tools.map((t) => qualifiedMcpToolName(t.method)) };
}
