import { z } from 'zod';

/**
 * One Control API method declaration (see `api.ts`). Lives in its own module so that the
 * per-track files under `ext/` can declare methods without importing `api.ts` (which spreads
 * them in).
 *
 * - `permission`: capability string checked for agent actors (defaults to the method name).
 * - `description`: English, LLM-facing. Also used to generate LLM tool definitions.
 * - `tool`: whether the method may be exposed as an LLM tool at all (still subject to grants).
 * - `mutates`: whether the method changes state.
 * - `longPoll`: the method blocks up to `params.timeoutMs`; clients extend their timeout.
 */
export interface MethodDef {
  params: z.ZodType;
  result: z.ZodType;
  description: string;
  permission?: string;
  tool?: boolean;
  mutates?: boolean;
  longPoll?: boolean;
}

/** Params are strict objects: unknown keys are `invalid_params`. */
export const params = z.strictObject;
export const empty = () => z.strictObject({});
export const Ok = z.object({ ok: z.literal(true) });
