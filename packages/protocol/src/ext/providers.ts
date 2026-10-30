/**
 * LLM providers beside LiteLLM (snapshot 20261030_providers): Anthropic's Messages API and
 * OpenAI's Responses API, each with its own key, and a ChatGPT plan used through "Sign in
 * with ChatGPT". Models name their provider with a prefix (`anthropic/…`, `openai/…`; no
 * prefix = LiteLLM, `mock/` = the built-in mock), so several providers live side by side and
 * a supervisor can give each child a different one.
 */
import { z } from 'zod';
import { type MethodDef, Ok, empty } from '../method';

/** Where a sign-in with ChatGPT stands (`chatgpt.status`). */
export const ChatGptState = z.enum(['signed_out', 'waiting', 'signed_in', 'error']);
export type ChatGptState = z.infer<typeof ChatGptState>;

export const ChatGptStatus = z.object({
  state: ChatGptState,
  /** Email of the signed-in account (from the ID token), when signed in. */
  email: z.string().nullable(),
  /** Why the last attempt failed, when `error`. */
  error: z.string().nullable(),
});
export type ChatGptStatus = z.infer<typeof ChatGptStatus>;

export const providerMethods = {
  'chatgpt.signIn': {
    params: empty(),
    result: z.object({
      /** Open this in a browser; the daemon waits on a loopback callback. */
      url: z.string(),
    }),
    description:
      'Start "Sign in with ChatGPT": the daemon opens a loopback listener and returns the authorization URL. Humans only.',
    tool: false,
    mutates: true,
  },
  'chatgpt.status': {
    params: empty(),
    result: ChatGptStatus,
    description: 'Whether a ChatGPT account is signed in, or a sign-in is waiting in the browser.',
    tool: false,
  },
  'chatgpt.signOut': {
    params: empty(),
    result: Ok,
    description: 'Revoke the ChatGPT sign-in and forget its tokens. Humans only.',
    tool: false,
    mutates: true,
  },
} as const satisfies Record<string, MethodDef>;
