/**
 * Keyboard decisions on approvals (Y / N / Ctrl+Y) need a fresh, deliberate key press.
 *
 * Approving removes the approval at once (optimistic), and the same card then shows the
 * session's next pending one. A held key (auto-repeat) or a quick second press would decide
 * that one before anyone read it, so repeats are ignored and, after a key decision, keys do
 * nothing for a moment. Shared by the focused card and Command Mode's window handler.
 */
export const KEY_DECISION_COOLDOWN_MS = 400;

let lastDecisionAt = Number.NEGATIVE_INFINITY;

export function claimKeyDecision(e: { repeat: boolean; timeStamp: number }): boolean {
  if (e.repeat) return false;
  if (e.timeStamp - lastDecisionAt < KEY_DECISION_COOLDOWN_MS) return false;
  lastDecisionAt = e.timeStamp;
  return true;
}

/** Tests only. */
export function resetKeyDecisions(): void {
  lastDecisionAt = Number.NEGATIVE_INFINITY;
}
