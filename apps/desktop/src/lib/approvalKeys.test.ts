// @vitest-environment node
import { beforeEach, describe, expect, it } from 'vitest';
import { KEY_DECISION_COOLDOWN_MS, claimKeyDecision, resetKeyDecisions } from './approvalKeys';

beforeEach(() => resetKeyDecisions());

describe('claimKeyDecision', () => {
  it('ignores auto-repeat and a second press right after a decision', () => {
    expect(claimKeyDecision({ repeat: false, timeStamp: 1000 })).toBe(true);
    // Held key, or the next approval swapped into the same card a moment later.
    expect(claimKeyDecision({ repeat: true, timeStamp: 1030 })).toBe(false);
    expect(claimKeyDecision({ repeat: false, timeStamp: 1100 })).toBe(false);
    expect(claimKeyDecision({ repeat: false, timeStamp: 1000 + KEY_DECISION_COOLDOWN_MS })).toBe(
      true,
    );
  });
});
