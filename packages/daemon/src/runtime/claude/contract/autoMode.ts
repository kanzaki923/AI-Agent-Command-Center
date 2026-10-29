import type { FakeReply, FakeRequest } from './fakeAnthropic';

/**
 * Stand-in for the auto mode classifier, for the fake API (probe and contract test).
 * Observed with the bundled CLI 2.1.312 (docs/snapshot/20261029_auto-mode.md): behind a custom
 * ANTHROPIC_BASE_URL the CLI sends its own classifier requests to the same `/v1/messages`,
 * without tools, in two stages (stage 1: max_tokens 64; stage 2 only when stage 1 flags the
 * action). The answer format depends on the classifier model's prompt:
 *
 * - `<block>yes|no</block>` (+ `<category>` / `<reason>`), stop sequence `</block>`
 *   (e.g. a Sonnet 4.6 session classifies with Sonnet 4.6);
 * - `<severity>0-100</severity>` (+ `<category>`), 50 is the boundary, stop `</severity>`
 *   (the default classifier model, Sonnet 5).
 */
export type ClassifierVerdict = 'allow' | 'block' | 'garbage';

/** Category the fake classifier names when it blocks (the CLI shows it as the reason). */
export const FAKE_BLOCK_CATEGORY = 'Probe Block';

/**
 * A request that is not the main loop: the main loop always carries the built-in tools
 * (Bash, Read, ...), and with nonessential traffic off the CLI sends no other side requests.
 */
export function isClassifierRequest(req: FakeRequest): boolean {
  const names = (req.body.tools ?? []).map((t) => t.name);
  return !names.includes('Bash') && !names.includes('Read');
}

export function classifierReply(req: FakeRequest, verdict: ClassifierVerdict): FakeReply {
  if (verdict === 'garbage') return { content: [{ type: 'text', text: '???' }] };
  const block = verdict === 'block';
  const severity = JSON.stringify(req.body.messages ?? '').includes('<severity>');
  const text = severity
    ? block
      ? `<severity>90</severity><category>${FAKE_BLOCK_CATEGORY}</category>`
      : '<severity>10</severity>'
    : block
      ? `<block>yes</block><category>${FAKE_BLOCK_CATEGORY}</category>` +
        `<reason>[${FAKE_BLOCK_CATEGORY}] blocked by the fake classifier</reason>`
      : '<block>no</block>';
  return { content: [{ type: 'text', text }] };
}

/**
 * What the server-side review answers (`message_delta.delta.safeguard_results`), as the real
 * Anthropic API returned it through LiteLLM (docs/snapshot/20261029_auto-mode-cost.md) and as
 * the bundled CLI 2.1.312 parses it: one `dangerous_tool_use` entry whose status is
 * `available` with a per-tool-use verdict, or `unsupported` / `unavailable`.
 */
export type ServerVerdict = 'not_flagged' | 'flagged' | 'unsupported' | 'unavailable';

/** The server's explanation when the fake flags an action. */
export const FAKE_SERVER_EXPLANATION = 'The fake server judged this action dangerous';

export function safeguardResults(toolUseIds: string[], verdict: ServerVerdict): unknown[] {
  const status =
    verdict === 'unsupported'
      ? { type: 'unsupported' }
      : verdict === 'unavailable'
        ? { type: 'unavailable', reason: 'error' }
        : {
            type: 'available',
            tool_uses: Object.fromEntries(
              toolUseIds.map((id) => [
                id,
                {
                  type: 'evaluated',
                  outcome: verdict,
                  ...(verdict === 'flagged' ? { explanation: FAKE_SERVER_EXPLANATION } : {}),
                },
              ]),
            ),
          };
  return [{ type: 'dangerous_tool_use', status }];
}
