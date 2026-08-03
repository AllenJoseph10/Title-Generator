import { describe, expect, it } from 'vitest';
import { ConsecutiveFailureTracker, CONSECUTIVE_FAILURE_LIMIT } from './circuit-breaker';

describe('ConsecutiveFailureTracker', () => {
  it('does not trip on isolated failures separated by successes', () => {
    const t = new ConsecutiveFailureTracker();
    expect(t.recordFailure()).toBe(false);
    t.recordSuccess();
    expect(t.recordFailure()).toBe(false);
    t.recordSuccess();
    expect(t.recordFailure()).toBe(false);
  });

  it('trips once the consecutive limit is reached', () => {
    const t = new ConsecutiveFailureTracker();
    for (let i = 0; i < CONSECUTIVE_FAILURE_LIMIT - 1; i++) {
      expect(t.recordFailure()).toBe(false);
    }
    expect(t.recordFailure()).toBe(true);
  });

  it('a success resets the streak so it does not trip early afterward', () => {
    const t = new ConsecutiveFailureTracker();
    expect(t.recordFailure()).toBe(false);
    expect(t.recordFailure()).toBe(false);
    t.recordSuccess();
    expect(t.recordFailure()).toBe(false);
    expect(t.current).toBe(1);
  });

  it('respects a custom limit', () => {
    const t = new ConsecutiveFailureTracker();
    expect(t.recordFailure(1)).toBe(true);
  });
});
