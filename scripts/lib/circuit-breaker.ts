// Consecutive (not cumulative) failure tracking for the batch scripts.
//
// Isolated bad videos — a corrupt download, one flaky network blip — must
// not halt a long batch (extract-burned-in-titles / describe-videos process
// anywhere from ~10 to ~100+ videos per invocation). But a systemic break —
// a schema rejection on every response, a model rename, a revoked key — will
// fail EVERY subsequent call. Without a breaker, that condition silently
// burns through the remaining list while `cost` in the final report stays
// near-zero (the failing calls may still be billed; see ProviderCallFailure
// in scripts/lib/provider-call-failure.ts), which is exactly backwards.
//
// Threshold of 3: three unrelated videos failing back to back is already an
// unlikely coincidence if failures are independent and isolated, so it is a
// strong signal of a systemic problem rather than bad luck, while still
// tolerating a couple of one-off blips in a row without aborting a short
// creator batch prematurely.
export const CONSECUTIVE_FAILURE_LIMIT = 3;

export class ConsecutiveFailureTracker {
  private count = 0;

  get current(): number {
    return this.count;
  }

  recordSuccess(): void {
    this.count = 0;
  }

  // Returns true once `limit` consecutive failures have been recorded — the
  // caller should abort the run when this returns true.
  recordFailure(limit: number = CONSECUTIVE_FAILURE_LIMIT): boolean {
    this.count += 1;
    return this.count >= limit;
  }
}
