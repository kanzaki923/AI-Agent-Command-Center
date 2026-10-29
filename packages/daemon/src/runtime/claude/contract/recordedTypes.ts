import { join } from 'node:path';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';

/**
 * The type recorded SDK message streams are checked against (`satisfies RecordedStream`).
 *
 * - The SDK's own message shapes (system/init, result, modelUsage, ...) are checked strictly:
 *   every property sdk.d.ts declares as required must be present with its type, so an SDK
 *   upgrade that renames or retypes a field we rely on fails typecheck.
 * - The Anthropic API objects the CLI passes through (`message`, `event`) are checked for the
 *   types of the properties present only: the SDK types them with the API client's
 *   non-streaming shapes (e.g. `citations` / `container` required), which streamed data and
 *   gateways do not always carry.
 * - Properties the types do not declare (the CLI sends more than sdk.d.ts documents) are
 *   allowed at every depth.
 */
type Primitive = string | number | boolean | bigint | symbol | null | undefined;

// Primitives first: branded strings such as `(string & {})` in model names must stay strings.
export type Loose<T> = T extends Primitive
  ? T
  : T extends readonly (infer U)[]
    ? readonly Loose<U>[]
    : T extends object
      ? { [K in keyof T]: K extends 'message' | 'event' ? ApiShape<T[K]> : Loose<T[K]> } & {
          [key: string]: unknown;
        }
      : T;

/** Deep partial with extra properties allowed (for pass-through API objects). */
export type ApiShape<T> = T extends Primitive
  ? T
  : T extends readonly (infer U)[]
    ? readonly ApiShape<U>[]
    : T extends object
      ? { [K in keyof T]?: ApiShape<T[K]> } & { [key: string]: unknown }
      : T;

export type RecordedMessage = Loose<SDKMessage>;
export type RecordedStream = readonly RecordedMessage[];

/** Placeholders the recorder puts in place of local paths. */
export const REPO_PLACEHOLDER = '<REPO>';
export const ROOT_PLACEHOLDER = '<ROOT>';

/**
 * A recorded stream with the placeholders replaced (e.g. by the test's cwd), so paths in tool
 * inputs and results resolve like they did when recorded.
 */
export function withPaths(
  stream: RecordedStream,
  paths: { repo: string; root?: string },
): unknown[] {
  // A placeholder plus the path segments after it ("<REPO>\src\a.ts" as recorded on Windows),
  // rebuilt with this platform's separators so tests behave the same everywhere.
  const fix = (s: string) => {
    let out = s;
    for (const [ph, base] of [
      [REPO_PLACEHOLDER, paths.repo],
      [ROOT_PLACEHOLDER, paths.root],
    ] as const) {
      if (!base) continue;
      out = out.replace(
        new RegExp(`${ph}((?:[\\\\/]+[^\\\\/\\s"'<>]+)*)`, 'g'),
        (_m, rest: string) => join(base, ...rest.split(/[\\/]+/).filter(Boolean)),
      );
    }
    return out;
  };
  const walk = (v: unknown): unknown => {
    if (typeof v === 'string') return fix(v);
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') {
      return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]));
    }
    return v;
  };
  return stream.map(walk);
}
