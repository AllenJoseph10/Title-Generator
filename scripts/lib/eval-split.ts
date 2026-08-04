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

// Expands the group-level fold assignment into the rows belonging to one
// fold. This is the row-expansion point: the "a group never splits across
// folds" property is only checkable here, since assignFolds itself returns
// one fold index per group and cannot express row-level divergence at all.
export function rowsInFold<T>(groups: TitleGroup<T>[], folds: number[], foldIndex: number): T[] {
  if (groups.length !== folds.length) {
    throw new Error(`rowsInFold: groups (${groups.length}) and folds (${folds.length}) length mismatch`);
  }
  const out: T[] = [];
  groups.forEach((g, i) => {
    if (folds[i] === foldIndex) out.push(...g.rows);
  });
  return out;
}
