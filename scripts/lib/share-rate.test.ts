import { describe, expect, it } from 'vitest';
import { shareRateOf } from './share-rate';

describe('shareRateOf', () => {
  it('divides shares by the views fetched in the same call', () => {
    // Both readings come from one /instagram/post/stats response, so the
    // numerator and denominator describe the same instant.
    const r = shareRateOf({ views: 1_000, socialcrawl: { shares: 20, views: 2_000 } });
    expect(r).toBeCloseTo(0.01, 10);
  });

  it('prefers the contemporaneous denominator over the older stored one', () => {
    // The stored `views` predates the share reading. On a video that kept
    // accumulating views, using it inflates the rate — the reason this
    // function exists.
    const stale = shareRateOf({ views: 1_000, socialcrawl: { shares: 20, views: 2_600 } });
    expect(stale).toBeCloseTo(20 / 2_600, 10);
    expect(stale).not.toBeCloseTo(20 / 1_000, 5);
  });

  it('falls back to the stored views when the call returned none', () => {
    const r = shareRateOf({ views: 1_000, socialcrawl: { shares: 20, views: null } });
    expect(r).toBeCloseTo(0.02, 10);
  });

  it('is null when there is no share reading', () => {
    // An absent share count means no reading, never zero — a zero would rank a
    // genuinely unmeasured video at the bottom.
    expect(shareRateOf({ views: 1_000, socialcrawl: { shares: null, views: 1_000 } })).toBeNull();
    expect(shareRateOf({ views: 1_000 })).toBeNull();
  });

  it('is null when no view count is available from either source', () => {
    expect(shareRateOf({ views: null, socialcrawl: { shares: 20, views: null } })).toBeNull();
  });

  it('is null rather than Infinity when views are zero', () => {
    expect(shareRateOf({ views: 0, socialcrawl: { shares: 20, views: 0 } })).toBeNull();
    expect(shareRateOf({ views: 0, socialcrawl: { shares: 20, views: null } })).toBeNull();
  });

  it('reports a genuine zero share count as zero, not as missing', () => {
    // A video that was measured and got no shares is data, not absence.
    expect(shareRateOf({ views: 1_000, socialcrawl: { shares: 0, views: 1_000 } })).toBe(0);
  });
});
