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

  it('groups the two copies of a duplicated title into one unit of assignment', () => {
    // The group is the unit of assignment: assignFolds returns one fold per group.
    // Rows within a group cannot diverge by construction (it returns a single value
    // per group, not per row). The no-split property is therefore structural and
    // verified at the row-expansion point in the eval harness, not here.
    // This test verifies the prerequisite: groupByTitle actually groups the duplicates.
    const groups = groupByTitle([
      { title: 'dupe', hook_family: 'a' },
      { title: 'DUPE', hook_family: 'a' },
      ...many(9, 'a'),
    ]);
    const dupeIdx = groups.findIndex((g) => g.key === 'dupe');
    expect(groups[dupeIdx].rows).toHaveLength(2);

    const folds = assignFolds(groups, 5, (g) => g.rows[0].hook_family, mulberry32(3));
    expect(folds.length).toBe(groups.length);
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
