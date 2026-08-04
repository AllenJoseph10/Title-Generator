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
