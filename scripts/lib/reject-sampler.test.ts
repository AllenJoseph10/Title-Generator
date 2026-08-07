import { describe, expect, test } from 'vitest';
import { isEligible, selectRejects, type RejectCandidate, type SelectionCriteria } from './reject-sampler';

const CRITERIA: SelectionCriteria = {
  statuses: ['excluded_low_views', 'excluded_rank'],
  minViews: 20_000,
  maxMultiplier: 3,
  maxDurationSec: 60,
  total: 180,
  perCreatorCap: 60,
  capOverrides: {},
  seed: 1,
};

function row(over: Partial<RejectCandidate> = {}): RejectCandidate {
  return {
    handle: 'creator_a',
    shortcode: `sc_${Math.random().toString(36).slice(2, 9)}`,
    views: 100_000,
    durationSec: 20,
    outlierMultiplier: 1.2,
    status: 'excluded_low_views',
    ...over,
  };
}

// Deterministic shortcodes, so assertions can name specific rows.
function rows(n: number, over: Partial<RejectCandidate> = {}): RejectCandidate[] {
  return Array.from({ length: n }, (_, i) => row({ shortcode: `${over.handle ?? 'creator_a'}_${i}`, ...over }));
}

describe('isEligible', () => {
  test('excludes a row below the views floor', () => {
    expect(isEligible(row({ views: 19_999 }), CRITERIA)).toBe(false);
  });

  test('includes a row exactly at the views floor', () => {
    expect(isEligible(row({ views: 20_000 }), CRITERIA)).toBe(true);
  });

  test('excludes a row whose views are unknown', () => {
    // share_rate is shares/views. A null denominator cannot be scored, and
    // admitting it would put an unscoreable row into a corpus whose whole
    // purpose is the performance percentile.
    expect(isEligible(row({ views: null }), CRITERIA)).toBe(false);
  });

  test('excludes a row at or above the max multiplier', () => {
    expect(isEligible(row({ outlierMultiplier: 3 }), CRITERIA)).toBe(false);
  });

  test('excludes a row with no recorded multiplier', () => {
    expect(isEligible(row({ outlierMultiplier: undefined }), CRITERIA)).toBe(false);
  });

  test('excludes a row longer than the duration cap', () => {
    expect(isEligible(row({ durationSec: 61 }), CRITERIA)).toBe(false);
  });

  test('keeps a row whose duration is unknown', () => {
    // Matches refresh-media-urls.ts: an unknown duration is not a reason to
    // discard. probeVideo enforces the real cap once the file is downloaded.
    expect(isEligible(row({ durationSec: null }), CRITERIA)).toBe(true);
  });

  test('excludes a row whose status is not an eligible reject status', () => {
    expect(isEligible(row({ status: 'included' }), CRITERIA)).toBe(false);
  });
});

describe('selectRejects', () => {
  test('never returns more than the requested total', () => {
    const got = selectRejects(rows(500), { ...CRITERIA, total: 180, perCreatorCap: 500 });
    expect(got).toHaveLength(180);
  });

  test('returns every eligible row when supply is below the total', () => {
    const got = selectRejects(rows(12), { ...CRITERIA, total: 180 });
    expect(got).toHaveLength(12);
  });

  test('respects the per-creator cap', () => {
    const got = selectRejects(rows(200), { ...CRITERIA, total: 180, perCreatorCap: 35 });
    expect(got).toHaveLength(35);
  });

  test('applies a per-creator override in place of the default cap', () => {
    const pool = [...rows(100, { handle: 'henryjwade' }), ...rows(100, { handle: 'creator_b' })];
    const got = selectRejects(pool, {
      ...CRITERIA,
      total: 180,
      perCreatorCap: 60,
      capOverrides: { henryjwade: 35 },
    });
    expect(got.filter((r) => r.handle === 'henryjwade')).toHaveLength(35);
    expect(got.filter((r) => r.handle === 'creator_b')).toHaveLength(60);
  });

  test('a zero override excludes that creator entirely', () => {
    const pool = [...rows(50, { handle: 'henryjwade' }), ...rows(50, { handle: 'creator_b' })];
    const got = selectRejects(pool, { ...CRITERIA, capOverrides: { henryjwade: 0 } });
    expect(got.some((r) => r.handle === 'henryjwade')).toBe(false);
  });

  test('is deterministic for a given seed', () => {
    const pool = rows(400);
    const a = selectRejects(pool, { ...CRITERIA, seed: 20260807 });
    const b = selectRejects(pool, { ...CRITERIA, seed: 20260807 });
    expect(a.map((r) => r.shortcode)).toEqual(b.map((r) => r.shortcode));
  });

  test('a different seed selects a different sample', () => {
    const pool = rows(400);
    const a = selectRejects(pool, { ...CRITERIA, seed: 1 });
    const b = selectRejects(pool, { ...CRITERIA, seed: 2 });
    expect(a.map((r) => r.shortcode)).not.toEqual(b.map((r) => r.shortcode));
  });

  test('never returns the same row twice', () => {
    const pool = [...rows(200, { handle: 'creator_a' }), ...rows(200, { handle: 'creator_b' })];
    const got = selectRejects(pool, { ...CRITERIA, total: 180, perCreatorCap: 200 });
    expect(new Set(got.map((r) => r.shortcode)).size).toBe(got.length);
  });

  test('spreads the total across creators instead of exhausting one', () => {
    // The whole point of stratifying: 180 slots over 3 creators with 200 rows
    // each must not come back as 180 rows of creator_a.
    const pool = [
      ...rows(200, { handle: 'creator_a' }),
      ...rows(200, { handle: 'creator_b' }),
      ...rows(200, { handle: 'creator_c' }),
    ];
    const got = selectRejects(pool, { ...CRITERIA, total: 180, perCreatorCap: 200 });
    for (const h of ['creator_a', 'creator_b', 'creator_c']) {
      expect(got.filter((r) => r.handle === h)).toHaveLength(60);
    }
  });

  test('redistributes a short creator\'s unused slots to creators with supply', () => {
    // creator_c can only offer 5. Those 55 slots must go somewhere, not be
    // silently dropped — otherwise the run quietly under-fills the budget.
    const pool = [
      ...rows(200, { handle: 'creator_a' }),
      ...rows(200, { handle: 'creator_b' }),
      ...rows(5, { handle: 'creator_c' }),
    ];
    const got = selectRejects(pool, { ...CRITERIA, total: 180, perCreatorCap: 200 });
    expect(got).toHaveLength(180);
    expect(got.filter((r) => r.handle === 'creator_c')).toHaveLength(5);
  });

  test('drops ineligible rows before sampling', () => {
    const pool = [...rows(50, { handle: 'creator_a' }), ...rows(50, { handle: 'creator_b', views: 100 })];
    const got = selectRejects(pool, { ...CRITERIA, total: 180, perCreatorCap: 200 });
    expect(got).toHaveLength(50);
    expect(got.every((r) => r.handle === 'creator_a')).toBe(true);
  });
});
