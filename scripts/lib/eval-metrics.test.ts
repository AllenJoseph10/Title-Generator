import { describe, expect, it } from 'vitest';
import { rankdata, spearman, slatePrecisionAtK, meanSd } from './eval-metrics';

describe('rankdata', () => {
  it('ranks distinct values from 1', () => {
    expect(rankdata([10, 30, 20])).toEqual([1, 3, 2]);
  });

  it('gives tied values their average rank', () => {
    // values 2 and 2 occupy ranks 2 and 3 -> both get 2.5
    expect(rankdata([1, 2, 2, 3])).toEqual([1, 2.5, 2.5, 4]);
  });

  it('gives every value the same rank when all are tied', () => {
    expect(rankdata([5, 5, 5])).toEqual([2, 2, 2]);
  });
});

describe('spearman', () => {
  it('returns 1 for a perfectly concordant ranking', () => {
    expect(spearman([1, 2, 3, 4], [10, 20, 30, 40])).toBeCloseTo(1, 10);
  });

  it('returns -1 for a perfectly discordant ranking', () => {
    expect(spearman([1, 2, 3, 4], [40, 30, 20, 10])).toBeCloseTo(-1, 10);
  });

  it('computes a known intermediate value', () => {
    // ranks are the values themselves; Pearson works out to exactly 0.8
    expect(spearman([1, 2, 3, 4, 5], [2, 1, 4, 3, 5])).toBeCloseTo(0.8, 10);
  });

  it('handles partial ties via average ranks', () => {
    // a ranks -> [1, 2.5, 2.5, 4]; b ranks -> [1, 2, 3, 4]
    expect(spearman([1, 2, 2, 3], [1, 2, 3, 4])).toBeCloseTo(0.9487, 4);
  });

  it('returns null rather than NaN when one side has no variance', () => {
    // The constant-0.5 baseline hits this. NaN would print as "NaN" and read
    // as a crash; 0 would read as "no correlation", which is a different and
    // false claim. Undefined is the truth.
    expect(spearman([1, 2, 3], [7, 7, 7])).toBeNull();
  });

  it('throws on length mismatch rather than silently truncating', () => {
    expect(() => spearman([1, 2], [1, 2, 3])).toThrow(/length/);
  });
});

describe('slatePrecisionAtK', () => {
  it('returns 1 when the top-k sets match exactly', () => {
    const pred = [0.9, 0.8, 0.7, 0.1, 0.2];
    const actual = [0.5, 0.6, 0.7, 0.0, 0.1];
    // top-3 by pred = indices 0,1,2; top-3 by actual = indices 2,1,0
    expect(slatePrecisionAtK(pred, actual, 3)).toBe(1);
  });

  it('returns 0 when the top-k sets are disjoint', () => {
    const pred = [0.9, 0.8, 0.1, 0.0];
    const actual = [0.1, 0.0, 0.9, 0.8];
    expect(slatePrecisionAtK(pred, actual, 2)).toBe(0);
  });

  it('scores partial overlap as a fraction of k', () => {
    const pred = [0.9, 0.8, 0.1];
    const actual = [0.9, 0.1, 0.8];
    // top-2 pred = {0,1}; top-2 actual = {0,2}; overlap {0} -> 1/2
    expect(slatePrecisionAtK(pred, actual, 2)).toBe(0.5);
  });

  it('breaks prediction ties by index so results are deterministic', () => {
    const pred = [0.5, 0.5, 0.5];
    const actual = [0.1, 0.9, 0.2];
    // all predictions tie -> stable order picks index 0; actual top-1 is 1
    expect(slatePrecisionAtK(pred, actual, 1)).toBe(0);
  });
});

describe('meanSd', () => {
  it('computes the mean and population standard deviation', () => {
    const { mean, sd } = meanSd([2, 4, 4, 4, 5, 5, 7, 9]);
    expect(mean).toBeCloseTo(5, 10);
    expect(sd).toBeCloseTo(2, 10);
  });

  it('reports zero spread for a single sample', () => {
    expect(meanSd([3])).toEqual({ mean: 3, sd: 0 });
  });
});
