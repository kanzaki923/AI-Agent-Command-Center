import { type Actor, type MethodName, api, isMethodName, matchAnyPattern } from '@acc/protocol';
import { z } from 'zod';
import type { DaemonContext } from '../core/context';
import type { ToolSpec } from './types';

/**
 * A tool the tool loop can offer and execute. API tools wrap a Control API method; other
 * modules may add custom tools (e.g. orchestration helpers) with the same shape.
 */
export interface LoopTool extends ToolSpec {
  /** The Control API method this tool calls (for display and events), if any. */
  method?: MethodName;
  execute(input: unknown, opts: { signal: AbortSignal }): Promise<unknown>;
}

/**
 * Tool names must match `^[a-zA-Z0-9_-]{1,64}$`, so the dots in method names become "__"
 * (method names never contain "__").
 */
export function toolNameForMethod(method: string): string {
  return method.replaceAll('.', '__');
}

export function methodForToolName(name: string): string {
  return name.replaceAll('__', '.');
}

const schemaCache = new Map<string, Record<string, unknown>>();

/** JSON Schema of a method's params, as the model should send them (defaults optional). */
export function paramsJsonSchema(method: MethodName): Record<string, unknown> {
  let schema = schemaCache.get(method);
  if (!schema) {
    const raw = z.toJSONSchema(api[method].params, {
      io: 'input',
      unrepresentable: 'any',
    }) as Record<string, unknown>;
    delete raw.$schema;
    schema = raw;
    schemaCache.set(method, schema);
  }
  return schema;
}

export interface ApiToolsOptions {
  /** Only methods matching these patterns (e.g. ["task.*", "session.get"]). */
  include?: string[];
  /** Drop methods matching these patterns. */
  exclude?: string[];
}

/**
 * LLM tools generated from the Control API contract: every implemented method with
 * `tool !== false` whose permission the actor's grants allow (checked through
 * `ctx.policy`, ignoring project scope, which the dispatcher enforces per call). Executing
 * a tool goes through the full dispatcher as `actor`, exactly like a human call.
 */
export function apiTools(ctx: DaemonContext, actor: Actor, opts: ApiToolsOptions = {}): LoopTool[] {
  const tools: LoopTool[] = [];
  // Listing tools is not a call: do not audit the methods left out as denials.
  const { policy } = ctx;
  const allowed = (permission: string) =>
    (policy.peek
      ? policy.peek(actor, permission, undefined)
      : policy.check(actor, permission, undefined)
    ).allowed;
  for (const name of ctx.methods.names()) {
    if (!isMethodName(name)) continue;
    const spec = api[name];
    if (!spec.tool) continue;
    if (opts.include && !matchAnyPattern(opts.include, name)) continue;
    if (opts.exclude && matchAnyPattern(opts.exclude, name)) continue;
    if (!allowed(spec.permission)) continue;
    tools.push({
      name: toolNameForMethod(name),
      description: spec.description,
      parameters: paramsJsonSchema(name),
      method: name,
      execute: (input, { signal }) => ctx.call(actor, name, input ?? {}, { signal }),
    });
  }
  return tools;
}
