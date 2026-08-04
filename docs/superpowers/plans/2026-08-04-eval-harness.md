# Eval Harness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a zero-cost, deterministic eval that measures whether `templateSimilarityPrior` ranks real titles better than chance, then make the prior load-bearing by displaying the best 5 of 10 generated titles.

**Architecture:** Held-out real corpus rows stand in for generated candidates. For each held-out row the eval rebuilds the app's retrieval funnel in memory (description-space cosine → top 30 → MMR at λ=0.6 → 8 neighbours), scores it with the app's own `computeTitlePrior`, and compares the predicted ranking against the row's known performance percentile. Repeated stratified group k-fold, seeded, no API calls.

**Tech Stack:** TypeScript, tsx, vitest, Supabase PostgREST over `fetch`. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-08-04-eval-harness-design.md`

## Global Constraints

- **No API calls.** Every embedding already exists in Postgres. Adding an OpenAI or Anthropic call to this script is a design violation.
- **No `Math.random` anywhere.** All randomness comes from the seeded `mulberry32` PRNG. A run must be byte-identical for a given seed.
- **Scripts import with relative paths**, not the `@/` alias — `../lib/retrieval/prior`, matching `scripts/import-dataset.ts`. The alias is not resolved for standalone tsx scripts.
- **Never import `lib/retrieval/search.ts` from a script.** It carries `import 'server-only'`, which throws outside the react-server condition. Shared constants live in `lib/retrieval/constants.ts` (Task 3).
- **Exit code is always 0.** This is a measurement, not a gate.
- Funnel constants, single source of truth: `RPC_LIMIT = 30`, `FINAL_K = 8`, `MMR_LAMBDA = 0.6`, `FAMILY_PRIOR_BLEND = 0.3`.
- Default seed: `20260804`. Folds: `5`. Repeats: `5`. Slates: `200`. Slate size: `10`.
- Per-family correlations are suppressed below **n=10**, printed as `n/a (n=8)`.
- Test files live beside their source as `scripts/lib/<name>.test.ts` and use `import { describe, expect, it } from 'vitest'`.

---

## File Structure

| File | Responsibility |
|---|---|
| `lib/retrieval/constants.ts` | **New.** Funnel constants, importable without `server-only` |
| `lib/retrieval/search.ts` | **Modified.** Imports the constants instead of declaring them |
| `lib/retrieval/prior.ts` | **Modified.** Optional `blend` parameter; export `FAMILY_PRIOR_BLEND` |
| `scripts/lib/eval-metrics.ts` | **New.** Ranking, Spearman, slate precision, mean/sd |
| `scripts/lib/eval-split.ts` | **New.** Seeded PRNG, title grouping, stratified fold assignment |
| `scripts/eval.ts` | **New.** Corpus load, funnel, fold loop, report |
| `EVAL.md` | **New.** What is measured, how to read it, current numbers |
| `lib/generation/orchestrator.ts` | **Modified (Task 6).** Sort by prior; export `DISPLAY_COUNT` |
| `app/api/generate/route.ts` | **Modified (Task 6).** Persist 10, return 5 |
| `app/api/generation/[id]/route.ts` | **Modified (Task 6).** Same slice for history |

**Deviation from the spec, deliberate:** §4b says export the constants *from* `search.ts`. Doing so would drag `server-only` and the Supabase client into a plain tsx script. Extracting them to `lib/retrieval/constants.ts` and having `search.ts` import them preserves the single-source-of-truth intent — the anti-drift property is the point, not the file it lives in.

---

### Task 1: Ranking metrics

**Files:**
- Create: `scripts/lib/eval-metrics.ts`
- Test: `scripts/lib/eval-metrics.test.ts`

**Interfaces:**
- Consumes: nothing (pure, no imports)
- Produces:
  - `rankdata(xs: number[]): number[]` — average ranks, ties shared
  - `spearman(a: number[], b: number[]): number | null` — `null` when either side has zero variance
  - `slatePrecisionAtK(pred: number[], actual: number[], k: number): number`
  - `meanSd(xs: number[]): { mean: number; sd: number }`

- [ ] **Step 1: Write the failing tests**

```ts
// scripts/lib/eval-metrics.test.ts
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run scripts/lib/eval-metrics.test.ts`
Expected: FAIL — `Failed to resolve import "./eval-metrics"`

- [ ] **Step 3: Write the implementation**

```ts
// scripts/lib/eval-metrics.ts
//
// Pure ranking metrics for the eval harness. No I/O, no randomness, no
// imports — so every claim the eval makes rests on something unit-tested.

// Average ranks, 1-based. Ties share the mean of the ranks they span, which
// is what Spearman requires: `templateSimilarityPrior` returns exactly 0.5
// whenever neighbours are empty, so ties are common rather than exotic.
export function rankdata(xs: number[]): number[] {
  const idx = xs.map((v, i) => ({ v, i })).sort((a, b) => a.v - b.v || a.i - b.i);
  const ranks = new Array<number>(xs.length);
  let i = 0;
  while (i < idx.length) {
    let j = i;
    while (j + 1 < idx.length && idx[j + 1].v === idx[i].v) j++;
    const avg = (i + j) / 2 + 1; // +1 for 1-based ranks
    for (let k = i; k <= j; k++) ranks[idx[k].i] = avg;
    i = j + 1;
  }
  return ranks;
}

// Spearman = Pearson correlation of the ranks.
//
// Returns null, never NaN or 0, when either side is constant. The constant-0.5
// baseline produces exactly that case, and both alternatives lie: NaN reads as
// a crash, 0 reads as "measured, no correlation".
export function spearman(a: number[], b: number[]): number | null {
  if (a.length !== b.length) {
    throw new Error(`spearman: length mismatch ${a.length} vs ${b.length}`);
  }
  if (a.length < 2) return null;

  const ra = rankdata(a);
  const rb = rankdata(b);
  const n = ra.length;
  const ma = ra.reduce((s, x) => s + x, 0) / n;
  const mb = rb.reduce((s, x) => s + x, 0) / n;

  let cov = 0, va = 0, vb = 0;
  for (let i = 0; i < n; i++) {
    const da = ra[i] - ma;
    const db = rb[i] - mb;
    cov += da * db;
    va += da * da;
    vb += db * db;
  }
  if (va === 0 || vb === 0) return null;
  return cov / Math.sqrt(va * vb);
}

// Overlap between the top-k chosen by prediction and the true top-k, over k.
// Ties break by ascending index so the result is reproducible.
export function slatePrecisionAtK(pred: number[], actual: number[], k: number): number {
  if (pred.length !== actual.length) {
    throw new Error(`slatePrecisionAtK: length mismatch ${pred.length} vs ${actual.length}`);
  }
  if (k <= 0 || k > pred.length) {
    throw new Error(`slatePrecisionAtK: k=${k} out of range for ${pred.length} items`);
  }
  const topK = (xs: number[]) =>
    new Set(
      xs.map((v, i) => ({ v, i }))
        .sort((x, y) => y.v - x.v || x.i - y.i)
        .slice(0, k)
        .map((x) => x.i),
    );
  const p = topK(pred);
  const t = topK(actual);
  let hits = 0;
  for (const i of p) if (t.has(i)) hits++;
  return hits / k;
}

export function meanSd(xs: number[]): { mean: number; sd: number } {
  if (xs.length === 0) throw new Error('meanSd: empty input');
  const mean = xs.reduce((s, x) => s + x, 0) / xs.length;
  const variance = xs.reduce((s, x) => s + (x - mean) ** 2, 0) / xs.length;
  return { mean, sd: Math.sqrt(variance) };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run scripts/lib/eval-metrics.test.ts`
Expected: PASS, 16 tests

- [ ] **Step 5: Commit**

```bash
git add scripts/lib/eval-metrics.ts scripts/lib/eval-metrics.test.ts
git commit -m "Add ranking metrics for the eval harness

Spearman returns null rather than NaN or 0 when a side is constant —
the constant-0.5 baseline hits exactly that case, and both alternatives
would misreport it."
```

---

### Task 2: Seeded splitter

**Files:**
- Create: `scripts/lib/eval-split.ts`
- Test: `scripts/lib/eval-split.test.ts`

**Interfaces:**
- Consumes: nothing (pure)
- Produces:
  - `mulberry32(seed: number): () => number`
  - `normalizeTitleKey(title: string): string`
  - `type TitleGroup<T> = { key: string; rows: T[] }`
  - `groupByTitle<T extends { title: string }>(rows: T[]): TitleGroup<T>[]`
  - `assignFolds<T>(groups: TitleGroup<T>[], folds: number, stratumOf: (g: TitleGroup<T>) => string, rand: () => number): number[]`

- [ ] **Step 1: Write the failing tests**

```ts
// scripts/lib/eval-split.test.ts
import { describe, expect, it } from 'vitest';
import { mulberry32, normalizeTitleKey, groupByTitle, assignFolds } from './eval-split';

type Row = { title: string; hook_family: string };

const rows = (specs: Array<[string, string]>): Row[] =>
  specs.map(([title, hook_family]) => ({ title, hook_family }));

describe('mulberry32', () => {
  it('produces the same sequence for the same seed', () => {
    const a = mulberry32(42);
    const b = mulberry32(42);
    expect([a(), a(), a()]).toEqual([b(), b(), b()]);
  });

  it('produces a different sequence for a different seed', () => {
    const a = mulberry32(1);
    const b = mulberry32(2);
    expect(a()).not.toBe(b());
  });

  it('stays within [0, 1)', () => {
    const r = mulberry32(7);
    for (let i = 0; i < 200; i++) {
      const v = r();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });
});

describe('normalizeTitleKey', () => {
  it('collapses case, surrounding space and internal runs of whitespace', () => {
    expect(normalizeTitleKey('  The  Art   of Dressing ')).toBe('the art of dressing');
  });

  it('treats a newline as whitespace', () => {
    expect(normalizeTitleKey('one\ntwo')).toBe('one two');
  });
});

describe('groupByTitle', () => {
  it('puts rows sharing a normalised title into one group', () => {
    const g = groupByTitle(rows([
      ['Same Title', 'a'],
      ['same title', 'a'],
      ['Different', 'b'],
    ]));
    expect(g).toHaveLength(2);
    expect(g.find((x) => x.key === 'same title')!.rows).toHaveLength(2);
  });

  it('keeps group order stable regardless of input duplication', () => {
    const g = groupByTitle(rows([['b', 'x'], ['a', 'x'], ['b', 'x']]));
    expect(g.map((x) => x.key)).toEqual(['b', 'a']);
  });
});

describe('assignFolds', () => {
  const many = (n: number, family: string): Row[] =>
    Array.from({ length: n }, (_, i) => ({ title: `${family}-${i}`, hook_family: family }));

  it('assigns every group exactly one fold in range', () => {
    const groups = groupByTitle([...many(20, 'a'), ...many(10, 'b')]);
    const folds = assignFolds(groups, 5, (g) => g.rows[0].hook_family, mulberry32(1));
    expect(folds).toHaveLength(groups.length);
    for (const f of folds) {
      expect(Number.isInteger(f)).toBe(true);
      expect(f).toBeGreaterThanOrEqual(0);
      expect(f).toBeLessThan(5);
    }
  });

  it('never splits a duplicated title across folds', () => {
    // The group is the unit of assignment, so both rows of a duplicate title
    // move together. Without this, a held-out row retrieves its own twin at
    // similarity ~1.0 and scores perfectly for the wrong reason.
    const groups = groupByTitle([
      { title: 'dupe', hook_family: 'a' },
      { title: 'DUPE', hook_family: 'a' },
      ...many(9, 'a'),
    ]);
    const dupeIdx = groups.findIndex((g) => g.key === 'dupe');
    expect(groups[dupeIdx].rows).toHaveLength(2);
    const folds = assignFolds(groups, 5, (g) => g.rows[0].hook_family, mulberry32(3));
    expect(typeof folds[dupeIdx]).toBe('number');
  });

  it('spreads a small stratum across folds instead of clustering it', () => {
    // listicle_reveal has 8 rows. Unstratified, a fold could contain none.
    const groups = groupByTitle([...many(40, 'big'), ...many(8, 'small')]);
    const folds = assignFolds(groups, 5, (g) => g.rows[0].hook_family, mulberry32(11));
    const smallFolds = new Set(
      groups.map((g, i) => (g.rows[0].hook_family === 'small' ? folds[i] : -1)).filter((f) => f >= 0),
    );
    expect(smallFolds.size).toBeGreaterThanOrEqual(4);
  });

  it('balances fold sizes to within one group', () => {
    const groups = groupByTitle(many(50, 'a'));
    const folds = assignFolds(groups, 5, () => 'a', mulberry32(5));
    const counts = [0, 0, 0, 0, 0];
    for (const f of folds) counts[f]++;
    expect(Math.max(...counts) - Math.min(...counts)).toBeLessThanOrEqual(1);
  });

  it('is deterministic for a seed and varies across seeds', () => {
    const groups = groupByTitle(many(30, 'a'));
    const strat = (g: { rows: Row[] }) => g.rows[0].hook_family;
    expect(assignFolds(groups, 5, strat, mulberry32(9)))
      .toEqual(assignFolds(groups, 5, strat, mulberry32(9)));
    expect(assignFolds(groups, 5, strat, mulberry32(9)))
      .not.toEqual(assignFolds(groups, 5, strat, mulberry32(10)));
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run scripts/lib/eval-split.test.ts`
Expected: FAIL — `Failed to resolve import "./eval-split"`

- [ ] **Step 3: Write the implementation**

```ts
// scripts/lib/eval-split.ts
//
// Grouping and fold assignment for the eval harness.
//
// Math.random is never used: "a repeatable metric we can track over time" is a
// stated requirement, and a run must be byte-identical for a given seed.

// mulberry32 — small, fast, well-distributed seeded PRNG.
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function next(): number {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function normalizeTitleKey(title: string): string {
  return title.trim().toLowerCase().replace(/\s+/g, ' ');
}

export type TitleGroup<T> = { key: string; rows: T[] };

// 7 titles in this corpus appear on two different shortcodes — the creators
// genuinely reused a hook. They are legitimate data but not independent
// samples, so they are grouped and always move between folds together.
export function groupByTitle<T extends { title: string }>(rows: T[]): TitleGroup<T>[] {
  const byKey = new Map<string, TitleGroup<T>>();
  for (const row of rows) {
    const key = normalizeTitleKey(row.title);
    const existing = byKey.get(key);
    if (existing) existing.rows.push(row);
    else byKey.set(key, { key, rows: [row] });
  }
  return [...byKey.values()]; // Map preserves insertion order
}

// Fisher-Yates against the supplied PRNG. Returns a new array.
function shuffled<T>(xs: T[], rand: () => number): T[] {
  const out = [...xs];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

// Stratified round-robin. Each stratum is shuffled, then dealt across folds
// from a running cursor that carries over between strata — so both each
// stratum and the overall fold sizes stay balanced.
//
// Returns a fold index per group, positionally aligned with `groups`.
export function assignFolds<T>(
  groups: TitleGroup<T>[],
  folds: number,
  stratumOf: (g: TitleGroup<T>) => string,
  rand: () => number,
): number[] {
  if (folds < 2) throw new Error(`assignFolds: need at least 2 folds, got ${folds}`);

  const byStratum = new Map<string, number[]>();
  groups.forEach((g, i) => {
    const s = stratumOf(g);
    const list = byStratum.get(s);
    if (list) list.push(i);
    else byStratum.set(s, [i]);
  });

  const assignment = new Array<number>(groups.length);
  let cursor = 0;
  for (const indices of byStratum.values()) {
    for (const i of shuffled(indices, rand)) {
      assignment[i] = cursor % folds;
      cursor++;
    }
  }
  return assignment;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run scripts/lib/eval-split.test.ts`
Expected: PASS, 12 tests

- [ ] **Step 5: Commit**

```bash
git add scripts/lib/eval-split.ts scripts/lib/eval-split.test.ts
git commit -m "Add seeded stratified group splitter for the eval

Groups by normalised title so the 7 reused hooks never straddle a
fold — otherwise a held-out row retrieves its own twin at similarity
~1.0 and scores perfectly for the wrong reason."
```

---

### Task 3: Shared funnel constants and a tunable family blend

**Files:**
- Create: `lib/retrieval/constants.ts`
- Modify: `lib/retrieval/search.ts:7-9`
- Modify: `lib/retrieval/prior.ts:4-6,27-55`
- Test: `scripts/lib/prior-blend.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces:
  - `constants.ts`: `RPC_LIMIT = 30`, `FINAL_K = 8`, `MMR_LAMBDA = 0.6`
  - `prior.ts`: `computeTitlePrior(embedding, family, neighbors, blend?)`, `FAMILY_PRIOR_BLEND = 0.3` exported

Both changes are additive and behaviour-preserving. The app must run identically afterwards.

- [ ] **Step 1: Write the failing test**

```ts
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run scripts/lib/prior-blend.test.ts`
Expected: FAIL — `FAMILY_PRIOR_BLEND` is not exported

- [ ] **Step 3: Create the constants module**

```ts
// lib/retrieval/constants.ts
//
// Retrieval funnel constants, in their own module so scripts can import them
// without pulling in search.ts, which carries `import 'server-only'`.
//
// They live here rather than being copied into the eval on purpose: a copy
// drifts silently the first time someone tunes MMR, and the eval would keep
// reporting a number comparable to history while no longer describing the
// product.

export const RPC_LIMIT = 30;
export const FINAL_K = 8;
export const MMR_LAMBDA = 0.6; // Slight tilt toward diversity over pure relevance.
```

- [ ] **Step 4: Point search.ts at the shared constants**

Replace lines 7-9 of `lib/retrieval/search.ts`:

```ts
const RPC_LIMIT = 30;
const FINAL_K = 8;
const MMR_LAMBDA = 0.6; // Slight tilt toward diversity over pure relevance.
```

with an import added below the existing imports:

```ts
import { RPC_LIMIT, FINAL_K, MMR_LAMBDA } from './constants';
```

Values are unchanged; only their location moves.

- [ ] **Step 5: Add the optional blend parameter to prior.ts**

Export the constant on line 6:

```ts
export const FAMILY_PRIOR_BLEND = 0.3; // 30% weight on family-level prior, 70% on neighbors.
```

Change the signature and the blend line. The parameter is optional and defaults to the existing constant, so every current call site behaves identically:

```ts
export function computeTitlePrior(
  generatedEmbedding: number[],
  generatedFamily: HookFamily,
  neighbors: CorpusNeighbor[],
  // Optional so the app's behaviour is untouched. The eval overrides it to
  // isolate the neighbour signal (0) and to build the family-only baseline (1).
  blend: number = FAMILY_PRIOR_BLEND,
): number {
```

and replace the blended line:

```ts
  const blended = (1 - blend) * neighborMean + blend * familyMean;
```

- [ ] **Step 6: Run the full suite to verify nothing regressed**

Run: `npm test`
Expected: PASS — the 5 new tests plus all 111 existing ones (116 total)

- [ ] **Step 7: Verify the app still typechecks**

Run: `npm run typecheck`
Expected: clean, no output

- [ ] **Step 8: Commit**

```bash
git add lib/retrieval/constants.ts lib/retrieval/search.ts lib/retrieval/prior.ts scripts/lib/prior-blend.test.ts
git commit -m "Extract funnel constants and make the family blend tunable

Both additive. The eval must run the same funnel the app runs, and a
copied constant drifts the first time MMR is tuned — the eval would
then report a number comparable to history but no longer describing
the product.

Constants live in constants.ts rather than being exported from
search.ts because search.ts imports 'server-only', which throws in a
plain tsx script."
```

---

### Task 4: The eval script

**Files:**
- Create: `scripts/eval.ts`
- Modify: `package.json:19` (add the `eval` script)

**Interfaces:**
- Consumes: `eval-metrics.ts`, `eval-split.ts`, `lib/retrieval/constants.ts`, `lib/retrieval/prior.ts`, `lib/retrieval/mmr.ts`, `scripts/lib/load-env.ts`
- Produces: `npm run eval` printing the §8 report

This task is I/O orchestration, so it is verified by running it rather than by unit tests. Step 5 includes a built-in sanity check that proves the metric is wired correctly.

- [ ] **Step 1: Write the script**

```ts
// scripts/eval.ts
//
// Deliverable 4 — does templateSimilarityPrior rank titles better than chance?
//
// Scores held-out real corpus rows with the app's own computeTitlePrior,
// reproducing the retrieval funnel in memory, and compares the predicted
// ranking against known performance percentiles.
//
// Usage:
//   npm run eval
//   npm run eval -- --ground-truth view_outlier_score
//   npm run eval -- --family-blend 0
//   npm run eval -- --sanity
//
// Zero API calls: every embedding already exists in Postgres. Deterministic
// for a given seed. Always exits 0 — this is a measurement, not a gate.
//
// See docs/superpowers/specs/2026-08-04-eval-harness-design.md and EVAL.md.

import { loadEnvLocal, requireEnv } from './lib/load-env';
import { mulberry32, groupByTitle, assignFolds, type TitleGroup } from './lib/eval-split';
import { rankdata, spearman, slatePrecisionAtK, meanSd } from './lib/eval-metrics';
import { RPC_LIMIT, FINAL_K, MMR_LAMBDA } from '../lib/retrieval/constants';
import { computeTitlePrior, FAMILY_PRIOR_BLEND, type CorpusNeighbor } from '../lib/retrieval/prior';
import { cosineSimilarity, mmrRerank, type MmrCandidate } from '../lib/retrieval/mmr';
import type { HookFamily } from '../lib/hooks/taxonomy';

const DEFAULT_SEED = 20260804;
const FOLDS = 5;
const REPEATS = 5;
const SLATES = 200;
const SLATE_SIZE = 10;
const MIN_FAMILY_N = 10;
const PAGE = 25; // 25 rows x 2 vectors x 1536 floats is ~3MB per response.

type GroundTruth = 'performance_score' | 'view_outlier_score';

type Row = {
  id: string;
  title: string;
  hook_family: string;
  performance_score: number | null;
  view_outlier_score: number | null;
  titleVec: number[];
  descVec: number[];
};

type Options = {
  seed: number;
  repeats: number;
  groundTruth: GroundTruth;
  blend: number;
  slateSize: number;
  sanity: boolean;
};

function parseArgs(argv: string[]): Options {
  const o: Options = {
    seed: DEFAULT_SEED,
    repeats: REPEATS,
    groundTruth: 'performance_score',
    blend: FAMILY_PRIOR_BLEND,
    slateSize: SLATE_SIZE,
    sanity: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--seed') o.seed = parseInt(argv[++i], 10);
    else if (a === '--repeats') o.repeats = parseInt(argv[++i], 10);
    else if (a === '--slate-size') o.slateSize = parseInt(argv[++i], 10);
    else if (a === '--family-blend') o.blend = Number(argv[++i]);
    else if (a === '--sanity') o.sanity = true;
    else if (a === '--ground-truth') {
      const v = argv[++i];
      if (v !== 'performance_score' && v !== 'view_outlier_score') {
        throw new Error(`--ground-truth must be performance_score or view_outlier_score (got ${v})`);
      }
      o.groundTruth = v;
    } else throw new Error(`unknown argument: ${a}`);
  }
  if (!Number.isFinite(o.seed)) throw new Error('--seed requires a number');
  if (!Number.isInteger(o.repeats) || o.repeats < 1) throw new Error('--repeats requires a positive integer');
  if (!(o.blend >= 0 && o.blend <= 1)) throw new Error('--family-blend must be between 0 and 1');
  return o;
}

// ---------------------------------------------------------------- loading

// pgvector comes back from PostgREST as "[0.1,0.2,...]" rather than an array.
function toVector(v: number[] | string): number[] {
  return typeof v === 'string' ? (JSON.parse(v) as number[]) : v;
}

async function loadCorpus(): Promise<Row[]> {
  const url = process.env.SUPABASE_URL!;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY!;
  const headers = { apikey: key, authorization: `Bearer ${key}` };
  const select = 'id,title,hook_family,performance_score,view_outlier_score,embedding,description_embedding';

  const rows: Row[] = [];
  for (let offset = 0; ; offset += PAGE) {
    const res = await fetch(
      `${url}/rest/v1/corpus_titles?select=${select}&order=id&offset=${offset}&limit=${PAGE}`,
      { headers },
    );
    if (!res.ok) throw new Error(`load corpus: ${res.status} ${await res.text()}`);
    const page = (await res.json()) as Array<Record<string, never>>;
    if (page.length === 0) break;
    for (const r of page as unknown as Array<{
      id: string; title: string; hook_family: string;
      performance_score: number | null; view_outlier_score: number | null;
      embedding: number[] | string; description_embedding: number[] | string | null;
    }>) {
      if (r.description_embedding == null) continue; // invisible to retrieval anyway
      rows.push({
        id: r.id,
        title: r.title,
        hook_family: r.hook_family,
        performance_score: r.performance_score,
        view_outlier_score: r.view_outlier_score,
        titleVec: toVector(r.embedding),
        descVec: toVector(r.description_embedding),
      });
    }
    if (page.length < PAGE) break;
  }
  return rows;
}

// ---------------------------------------------------------------- funnel

// Rebuilds what retrieveAndRerank does, against an in-memory training set.
// search.ts cannot be reused: it queries the whole table via RPC with no way
// to exclude held-out rows, and it imports 'server-only'.
//
// Returns the neighbours rather than a score, so the headline and the
// family-only baseline can both be computed from ONE retrieval. Scoring twice
// would double the runtime for an identical neighbour set.
function retrieveNeighbors(test: Row, train: Row[], gt: GroundTruth): CorpusNeighbor[] {
  const scored = train.map((t) => ({ row: t, sim: cosineSimilarity(test.descVec, t.descVec) }));
  scored.sort((a, b) => b.sim - a.sim);

  const candidates: MmrCandidate<Row>[] = scored.slice(0, RPC_LIMIT).map((s) => ({
    item: s.row,
    relevance: s.sim,
    embedding: s.row.titleVec, // MMR diversifies as TITLES, as in the app
  }));

  return mmrRerank(candidates, FINAL_K, MMR_LAMBDA).map((c) => ({
    hook_family: c.item.hook_family,
    performance_score: c.item[gt],
    embedding: c.item.titleVec,
  }));
}

// ---------------------------------------------------------------- one repeat

type Prediction = { row: Row; predicted: number; familyOnly: number; actual: number };

function runRepeat(rows: Row[], gt: GroundTruth, opts: Options, seed: number): Prediction[] {
  // Rows without a ground truth can train (they are legitimate neighbours,
  // and computeTitlePrior filters nulls out of the mean) but can never test.
  const eligible = rows.filter((r) => r[gt] !== null);
  const groups = groupByTitle(eligible);
  const folds = assignFolds(groups, FOLDS, (g: TitleGroup<Row>) => g.rows[0].hook_family, mulberry32(seed));

  const out: Prediction[] = [];
  for (let f = 0; f < FOLDS; f++) {
    const testIds = new Set<string>();
    groups.forEach((g, i) => {
      if (folds[i] === f) for (const r of g.rows) testIds.add(r.id);
    });
    if (testIds.size === 0) continue;

    const train = rows.filter((r) => !testIds.has(r.id));
    for (const row of eligible) {
      if (!testIds.has(row.id)) continue;
      // One retrieval, two scorings — the family-only baseline reuses the
      // same neighbours and costs only an extra arithmetic pass.
      const neighbors = retrieveNeighbors(row, train, gt);
      const family = row.hook_family as HookFamily;
      out.push({
        row,
        predicted: computeTitlePrior(row.titleVec, family, neighbors, opts.blend),
        familyOnly: computeTitlePrior(row.titleVec, family, neighbors, 1),
        actual: row[gt] as number,
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------- reporting

function fmt(x: number | null, places = 3): string {
  return x === null ? '  n/a' : x.toFixed(places);
}

function slateMean(preds: Prediction[], k: number, size: number, rand: () => number): number {
  if (preds.length < size) throw new Error(`slate size ${size} exceeds ${preds.length} predictions`);
  const scores: number[] = [];
  for (let s = 0; s < SLATES; s++) {
    const pool = [...preds];
    const slate: Prediction[] = [];
    for (let i = 0; i < size; i++) {
      slate.push(pool.splice(Math.floor(rand() * pool.length), 1)[0]);
    }
    scores.push(slatePrecisionAtK(slate.map((p) => p.predicted), slate.map((p) => p.actual), k));
  }
  return meanSd(scores).mean;
}

async function main(): Promise<void> {
  loadEnvLocal();
  requireEnv(['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY']);
  const opts = parseArgs(process.argv.slice(2));

  const rows = await loadCorpus();
  const gt = opts.groundTruth;
  const eligible = rows.filter((r) => r[gt] !== null);

  console.log(`eval — ${eligible.length} of ${rows.length} rows scoreable, ` +
    `${FOLDS}-fold x ${opts.repeats} repeats, seed ${opts.seed}`);
  console.log(`ground truth: ${gt}        funnel: top-${RPC_LIMIT} -> MMR(${FINAL_K}, lambda=${MMR_LAMBDA})`);
  console.log(`family blend: ${opts.blend}\n`);

  if (opts.sanity) {
    // Feed each row's own ground truth back as its prediction. Anything other
    // than exactly 1.0 means the metric or the pairing is miswired.
    const s = spearman(eligible.map((r) => r[gt] as number), eligible.map((r) => r[gt] as number));
    console.log(`sanity: ground truth against itself -> ${fmt(s, 6)} (must be 1.000000)`);
    return;
  }

  const headline: number[] = [];
  const shuffledBase: number[] = [];
  const familyBase: number[] = [];
  const p3: number[] = [];
  const p5: number[] = [];
  const perFamily = new Map<string, { pred: number[]; act: number[] }>();

  for (let rep = 0; rep < opts.repeats; rep++) {
    const seed = opts.seed + rep * 1000;
    const preds = runRepeat(rows, gt, opts, seed);
    const rand = mulberry32(seed ^ 0x5eed);

    const predicted = preds.map((p) => p.predicted);
    const actual = preds.map((p) => p.actual);

    const h = spearman(predicted, actual);
    if (h !== null) headline.push(h);

    const fb = spearman(preds.map((p) => p.familyOnly), actual);
    if (fb !== null) familyBase.push(fb);

    // Shuffle the predictions against fixed actuals: same distribution, no signal.
    const shuf = [...predicted];
    for (let i = shuf.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [shuf[i], shuf[j]] = [shuf[j], shuf[i]];
    }
    const sb = spearman(shuf, actual);
    if (sb !== null) shuffledBase.push(sb);

    p3.push(slateMean(preds, 3, opts.slateSize, mulberry32(seed ^ 0xa11ce)));
    p5.push(slateMean(preds, 5, opts.slateSize, mulberry32(seed ^ 0xb0b)));

    for (const p of preds) {
      const e = perFamily.get(p.row.hook_family) ?? { pred: [], act: [] };
      e.pred.push(p.predicted);
      e.act.push(p.actual);
      perFamily.set(p.row.hook_family, e);
    }
  }

  const constant = spearman(eligible.map(() => 0.5), eligible.map((r) => r[gt] as number));

  const h = meanSd(headline);
  const sb = meanSd(shuffledBase);
  const fb = meanSd(familyBase);

  console.log('Spearman (headline)      ' + `${fmt(h.mean)} +/- ${fmt(h.sd)}`);
  console.log('  baseline: shuffled     ' + `${fmt(sb.mean)} +/- ${fmt(sb.sd)}`);
  console.log('  baseline: family-only  ' + `${fmt(fb.mean)} +/- ${fmt(fb.sd)}`);
  console.log('  baseline: constant 0.5 ' + `${fmt(constant)}   (undefined by construction)`);

  console.log(`\nslate precision (${opts.slateSize} candidates, ${SLATES} slates x ${opts.repeats} repeats)`);
  console.log(`  @3   ${fmt(meanSd(p3).mean)}   (random ${(3 / opts.slateSize).toFixed(3)})`);
  console.log(`  @5   ${fmt(meanSd(p5).mean)}   (random ${(5 / opts.slateSize).toFixed(3)})`);

  console.log('\nby hook family');
  const families = [...perFamily.entries()].sort((a, b) => b[1].pred.length - a[1].pred.length);
  for (const [family, e] of families) {
    const n = e.pred.length / opts.repeats;
    const line = `  ${family.padEnd(24)}n=${String(Math.round(n)).padEnd(6)}`;
    console.log(n < MIN_FAMILY_N ? `${line}n/a (below ${MIN_FAMILY_N})` : `${line}${fmt(spearman(e.pred, e.act))}`);
  }

  if (h.mean <= sb.mean + sb.sd) {
    console.log(`\n!! WARNING: the headline (${fmt(h.mean)}) does not clear the shuffled ` +
      `baseline (${fmt(sb.mean)} +/- ${fmt(sb.sd)}).`);
    console.log('   The prior is not distinguishable from noise on this corpus. See EVAL.md.');
  }
  if (h.mean <= fb.mean) {
    console.log(`\n!! WARNING: the headline (${fmt(h.mean)}) does not beat family-only ` +
      `(${fmt(fb.mean)}). Description-space retrieval is adding nothing over the hook family.`);
  }
}

// Always exit 0: a measurement that fails the build gets muted or deleted.
main().catch((e) => {
  console.error(`\n${(e as Error).message}`);
  process.exit(1);
});
```

- [ ] **Step 2: Register the npm script**

Add to `package.json` scripts, after `verify:retrieval`:

```json
    "eval": "tsx scripts/eval.ts"
```

Note there is no `--conditions=react-server`: nothing in the import graph carries `server-only`, which is why Task 3 moved the constants out of `search.ts`.

- [ ] **Step 3: Verify it typechecks**

Run: `npm run typecheck`
Expected: clean

- [ ] **Step 4: Run the sanity check**

Run: `npm run eval -- --sanity`
Expected: `sanity: ground truth against itself -> 1.000000 (must be 1.000000)`

If this is not exactly 1.000000, stop — the metric or the pairing is miswired and every other number is meaningless.

- [ ] **Step 5: Run the eval**

Run: `npm run eval`
Expected: the full report from §8 of the spec. Record the numbers; they go into `EVAL.md` in Task 5.

- [ ] **Step 6: Verify determinism**

Run: `npm run eval > /tmp/a.txt && npm run eval > /tmp/b.txt && diff /tmp/a.txt /tmp/b.txt`
Expected: no differences. Any diff means `Math.random` leaked in somewhere.

- [ ] **Step 7: Verify a different seed lands within the reported spread**

Run: `npm run eval -- --seed 99`
Expected: headline within roughly one sd of the default run's headline. A wild swing means the fold scheme is not stabilising the estimate.

- [ ] **Step 8: Commit**

```bash
git add scripts/eval.ts package.json
git commit -m "Add the eval harness

Scores held-out real corpus rows with the app's own computeTitlePrior,
reproducing the retrieval funnel in memory, against known performance
percentiles. Zero API calls, deterministic per seed.

Prints three baselines alongside the headline. The demanding one is
family-only: if the headline does not beat it, description-space
retrieval contributes nothing over knowing the hook family."
```

---

### Task 5: EVAL.md

**Files:**
- Create: `EVAL.md`

**Interfaces:**
- Consumes: the numbers printed in Task 4
- Produces: the written explanation the brief requires

- [ ] **Step 1: Write EVAL.md**

Use this structure, substituting the **actual** numbers from Task 4 Step 5. Do not invent numbers — if a section cannot be filled from a real run, re-run the eval.

````markdown
# Eval — does the prior rank titles better than chance?

`npm run eval`

## The question

The app attaches a `templateSimilarityPrior` to every generated title, and
that number claims the title would perform well. This measures whether the
claim holds.

## How it works

There is no ground truth for a title that was never posted, so generated
titles cannot be scored directly. Instead the eval scores **real corpus rows
whose performance is known**:

1. Hold out a fifth of the corpus; hide it from retrieval.
2. For each held-out row, rebuild the app's retrieval funnel over the
   remaining rows — description-space cosine, top 30, MMR(8, λ=0.6).
3. Score it with the app's own `computeTitlePrior`.
4. Compare the predicted ranking against the true performance percentile.

Repeated stratified 5-fold, 5 repeats, seeded. Every embedding already exists
in Postgres, so a run costs nothing and takes seconds.

## Ground truth

`performance_score` — the percentile rank of `share_rate` (`shares/views`)
across the corpus. `--ground-truth view_outlier_score` runs the alternative,
which correlates with the primary at only 0.410. See
`docs/findings/2026-08-02-performance-metric-decision.md`.

**Two caveats, both real:**

- **The percentile scale saw the test rows.** `performance_score` was computed
  over all 175 rows, so held-out rows contributed to the ranking they are
  scored against. The effect is one row's rank among 175. Recomputing
  percentiles per fold would remove it, at the cost of measuring a metric the
  app does not ship.
- **Views were never verified against the Instagram UI.** Views are the
  denominator of `performance_score`. Likes and comments are known to be
  ~21% and ~48% below what the app displays. If views carry a similar error,
  the ground truth inherits it.

## Reading the output

**Spearman (headline)** — rank correlation between predicted prior and true
performance, mean ± sd across repeats. This is the number to track.

**Baselines.** A headline of 0.15 means nothing until you know what noise
scores. `shuffled` is the noise floor. `family-only` is the demanding one:
beat it, or description-space retrieval is adding nothing over simply knowing
the hook family.

**Slate precision** — the product-facing metric. Sample 10 held-out rows,
rank by prior, ask how many of the top k were truly top k. Random ranking
gives 0.300 at k=3 and 0.500 at k=5.

**By hook family** — families below n=10 print `n/a`. 90 of 175 titles were
force-fitted into a family with low confidence, so a family scoring near zero
may be a labelling failure rather than a prior failure.

## Current numbers

Run on <DATE>, seed 20260804, 175-row corpus:

```
<PASTE THE ACTUAL OUTPUT OF `npm run eval` HERE>
```

**Interpretation:** <one honest paragraph — does it beat the baselines or not?>

## Known limits

- **172 scoreable rows**, below the brief's 200 floor. If the prior does not
  predict, corpus size is the first suspect, not the metric.
- The eval measures retrieval, MMR and the prior **together**. A poor number
  does not localise the fault; `--family-blend 0` is one probe for that.
- Nothing here evaluates title *quality* — only whether the prior's ordering
  matches real performance.

## Flags

| Flag | Default | Purpose |
|---|---|---|
| `--seed <n>` | `20260804` | Reproducibility |
| `--repeats <n>` | `5` | Tighter or faster estimates |
| `--ground-truth <col>` | `performance_score` | `view_outlier_score` runs the 0.410 experiment |
| `--family-blend <x>` | `0.3` | `0` isolates neighbours, `1` gives family-only |
| `--slate-size <n>` | `10` | Match the candidate pool |
| `--sanity` | off | Ground truth against itself; must print 1.000000 |
````

- [ ] **Step 2: Verify every placeholder is filled**

Run: `grep -n "<DATE>\|<PASTE\|<one honest" EVAL.md`
Expected: no matches. Any hit means a placeholder shipped.

- [ ] **Step 3: Commit**

```bash
git add EVAL.md
git commit -m "Add EVAL.md with the baseline eval numbers

Records the two caveats on the ground truth rather than burying them:
the percentile scale saw the test rows, and views were never checked
against the Instagram UI."
```

---

### Task 6: Generate 10, display the best 5

**Files:**
- Modify: `lib/generation/orchestrator.ts:124-144`
- Modify: `app/api/generate/route.ts:157,170`
- Modify: `app/api/generation/[id]/route.ts`

**Interfaces:**
- Consumes: `PipelineResult.titles` from `orchestrator.ts`, now sorted
- Produces: `DISPLAY_COUNT = 5` exported from `orchestrator.ts`

Do not start this until Task 5 is committed. The baseline must be recorded before the prior gains authority over what users see.

- [ ] **Step 1: Sort in the orchestrator and export the display count**

Add near the top of `lib/generation/orchestrator.ts`, beside `MAX_DURATION_SEC`:

```ts
// Generation still emits 10 candidates; the best DISPLAY_COUNT are shown.
// The rest are persisted, not discarded — they are the only record of real
// generations with real priors attached, which is future eval data.
export const DISPLAY_COUNT = 5;
```

Then, immediately before the `const durationMs = ...` line at the end of `runPipeline`, sort:

```ts
  // Nothing downstream sorted these before, so the app's "ranked" titles were
  // in model-emission order and the prior only painted a badge. Ordering here
  // is what makes the prior load-bearing. Ties keep emission order.
  titles.sort((a, b) => b.templateSimilarityPrior - a.templateSimilarityPrior);
```

- [ ] **Step 2: Persist all 10, return 5**

In `app/api/generate/route.ts`, leave the persistence line at 157 untouched so all 10 are stored:

```ts
    generated_titles: result.titles,
```

and slice only the response at line 170:

```ts
      titles: result.titles.slice(0, DISPLAY_COUNT),
```

adding `DISPLAY_COUNT` to the existing import from `@/lib/generation/orchestrator`.

- [ ] **Step 3: Apply the same slice to history**

In `app/api/generation/[id]/route.ts`, slice the stored `generated_titles` the same way before returning, so a generation viewed in history shows what was shown when it ran. Import `DISPLAY_COUNT` from `@/lib/generation/orchestrator`.

- [ ] **Step 4: Verify the build and types**

Run: `npm run typecheck && npm run build`
Expected: both clean

- [ ] **Step 5: Verify in the running app**

Run: `npm run dev`, log in with `APP_PASSCODE`, upload one of the sample clips, and confirm **5** titles render, in descending badge strength (`high` before `med` before `low`).

- [ ] **Step 6: Commit**

```bash
git add lib/generation/orchestrator.ts app/api/generate/route.ts "app/api/generation/[id]/route.ts"
git commit -m "Rank titles by prior and display the best 5 of 10

Nothing sorted generated titles before this: the prior drove a badge
and the displayed order was whatever the model emitted, so the brief's
'10 ranked ideas' was not what shipped.

Generation still emits 10 and all 10 are persisted — the 5 not shown
are the only record of real generations with real priors attached.
Only the API response is sliced.

Deviates from the brief, which specifies 10 shown. Project-owner
decision; noted in the handoff."
```

---

### Task 7: Re-measure and hand off

**Files:**
- Modify: `EVAL.md`
- Modify: `docs/SESSION-HANDOFF.md`

- [ ] **Step 1: Re-run the eval at the display count**

Run: `npm run eval -- --slate-size 10`
Expected: precision@5 against the 0.500 random baseline. That figure is the claim "selecting by prior beats showing the model's first 5", or its refutation.

- [ ] **Step 2: Record the result in EVAL.md**

Add a short section stating precision@5, the 0.500 random baseline, and whether prior-based selection is justified by the data. If it is not, say so plainly — that is a finding, and shipping the change anyway is a decision to record rather than hide.

- [ ] **Step 3: Update the handoff**

In `docs/SESSION-HANDOFF.md`, under REMAINING WORK, mark deliverable 4 done with the headline number, and add a line under OPEN ITEMS noting the display-count deviation from the brief (10 specified, 5 shipped) so Allen is told rather than left to discover it.

- [ ] **Step 4: Full verification**

Run: `npm test && npm run typecheck && npm run build`
Expected: all pass.

- [ ] **Step 5: Commit and push**

```bash
git add EVAL.md docs/SESSION-HANDOFF.md
git commit -m "Record the post-change eval number and update the handoff"
git push
```

---

## Self-Review

**Spec coverage:**

| Spec section | Task |
|---|---|
| §4b constants + blend param | 3 |
| §5 architecture, three files | 1, 2, 4 |
| §5.1 funnel data flow | 4 (`retrieveNeighbors`) |
| §5.2 groups, stratification, folds, repeats, PRNG | 2, 4 (`runRepeat`) |
| §5.3 eligibility — NULLs train but never test | 4 (`runRepeat`) |
| §6.1 Spearman headline, mean ± sd | 1, 4 |
| §6.2 three baselines, computed in the default run | 1, 4 |
| §6.3 slate precision @3 and @5 with analytic random baselines | 1, 4 (`slateMean`) |
| §6.4 per-family, suppressed below n=10 | 4 |
| §6.5 all five flags | 4 (`parseArgs`) |
| §7 leakage controls 1–3 | 2, 4 |
| §7.4 percentile leakage disclosed | 5 (EVAL.md) |
| §8 output format, warning, exit 0 | 4 |
| §9 Phase 2 | 6, 7 |
| §10 testing | 1, 2, 3 |
| §11 verification, incl. the sanity check | 4 (Steps 3–7) |
| §12 risks documented | 5 (EVAL.md "Known limits") |

No gaps.

**Placeholder scan:** The only intentional placeholders are `<DATE>`, `<PASTE…>` and `<one honest paragraph…>` inside the EVAL.md template, and Task 5 Step 2 is a `grep` that fails the task if any survive.

**Type consistency:** `TitleGroup<T>` is defined in Task 2 and consumed in Task 4. `CorpusNeighbor` is imported from `prior.ts` in both Task 3's test and Task 4. `computeTitlePrior`'s fourth parameter is `blend` in Task 3 and is passed positionally in Task 4. `Row.titleVec`/`Row.descVec` are defined once in Task 4 and used only there. `DISPLAY_COUNT` is exported in Task 6 Step 1 and imported in Steps 2 and 3.

**Fixed during review:** the first draft had `runRepeat` call a `scoreRow` helper twice per row — once at the configured blend and once at `blend = 1` — which re-ran the whole funnel for an identical neighbour set and contradicted the spec's "no second retrieval". Replaced with `retrieveNeighbors`, which returns the neighbour list so both scorings share one retrieval.

**Known cost:** ~4,300 retrievals, each ~140 cosines over 1,536 dimensions plus MMR. Expect seconds. If it disappoints, precompute the description-similarity matrix once per repeat rather than per row.
