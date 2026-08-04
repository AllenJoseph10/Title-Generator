// scripts/lib/prior-blend.test.ts
import { describe, expect, it } from 'vitest';
import { computeTitlePrior, FAMILY_PRIOR_BLEND } from '../../lib/retrieval/prior';
import type { CorpusNeighbor } from '../../lib/retrieval/prior';

// Three orthogonal unit vectors: the query matches n0 exactly and the others
// not at all, so neighbour ordering is unambiguous.
const e0 = [1, 0, 0];
const e1 = [0, 1, 0];
const e2 = [0, 0, 1];

const neighbors: CorpusNeighbor[] = [
  { hook_family: 'relatable_pov', performance_score: 1.0, embedding: e0 },
  { hook_family: 'listicle_reveal', performance_score: 0.0, embedding: e1 },
  { hook_family: 'listicle_reveal', performance_score: 0.0, embedding: e2 },
];

describe('computeTitlePrior blend parameter', () => {
  it('defaults to the app constant when omitted', () => {
    const withDefault = computeTitlePrior(e0, 'relatable_pov', neighbors);
    const explicit = computeTitlePrior(e0, 'relatable_pov', neighbors, FAMILY_PRIOR_BLEND);
    expect(withDefault).toBe(explicit);
  });

  it('blend=0 uses the neighbour mean alone', () => {
    // All three neighbours are within the top-5 window: mean = (1+0+0)/3.
    expect(computeTitlePrior(e0, 'relatable_pov', neighbors, 0)).toBeCloseTo(1 / 3, 10);
  });

  it('blend=1 uses the family mean alone', () => {
    // Family relatable_pov has one member, score 1.0.
    expect(computeTitlePrior(e0, 'relatable_pov', neighbors, 1)).toBeCloseTo(1.0, 10);
    // Family listicle_reveal has two members, both 0.0.
    expect(computeTitlePrior(e0, 'listicle_reveal', neighbors, 1)).toBeCloseTo(0.0, 10);
  });

  it('still ignores null scores rather than reading them as zero', () => {
    const withNull: CorpusNeighbor[] = [
      { hook_family: 'relatable_pov', performance_score: 1.0, embedding: e0 },
      { hook_family: 'relatable_pov', performance_score: null, embedding: e1 },
    ];
    expect(computeTitlePrior(e0, 'relatable_pov', withNull, 0)).toBeCloseTo(1.0, 10);
  });

  it('exports the app default unchanged', () => {
    expect(FAMILY_PRIOR_BLEND).toBe(0.3);
  });
});
