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
// for a given seed. The main report always exits 0 — it is a measurement,
// not a gate. --sanity is the one exception: it is a self-check on the
// harness itself, and it fails loudly (non-zero exit) if pairing is broken.
//
// See docs/superpowers/specs/2026-08-04-eval-harness-design.md and EVAL.md.

import { loadEnvLocal, requireEnv } from './lib/load-env';
import { mulberry32, groupByTitle, assignFolds, rowsInFold, type TitleGroup } from './lib/eval-split';
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
const NULL_DRAWS_PER_REPEAT = 200; // 200 x 5 repeats = 1000 permutation-null draws.

// Mirrors prior.ts's private FALLBACK_PRIOR. Not imported: prior.ts does not
// export it, and this task is scoped to eval.ts only — prior.ts stays untouched.
const NEUTRAL_PRIOR = 0.5;

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
// retrieval-dependent baselines can all be computed from ONE retrieval.
// Scoring twice would double the runtime for an identical neighbour set.
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

type Prediction = {
  row: Row;
  predicted: number;
  // blend=1 through computeTitlePrior: NOT a retrieval-free family baseline.
  // prior.ts's familyMean is computed over the same MMR-selected neighbours
  // that produced `predicted`, so this varies with retrieval per row and,
  // when none of a row's neighbours share its family, prior.ts falls back to
  // familyMean = neighborMean — making this byte-identical to `predicted`'s
  // neighbour term for that row. See `familyFallback` below.
  familyTermOnly: number;
  // Genuine retrieval-free baseline: mean ground truth of the row's hook
  // family over the fold's TRAINING set (out-of-fold, excludes this row) —
  // one value per family, no MMR, no per-row retrieval dependence.
  //
  // WARNING ON INTERPRETING THE SIGN: an out-of-fold group mean is
  // negatively biased under the null by construction, independent of
  // whether hook family carries any real effect. For a held-out row in
  // family F, Cov(prediction, actual) = B - sum_F w_F * sigma_F^2/(N_F-1),
  // where B is between-family variance and sigma_F^2 is within-family
  // variance; under "no real family effect" E[B] is smaller than the
  // penalty term by construction, leaving Cov < 0 always, regardless of
  // fold size. So a negative value here is NOT evidence that hook family is
  // anti-predictive — only the comparison to the headline (computed the
  // same, out-of-fold, way) is apples-to-apples. `familyMeanAll` below is
  // the same estimator without the bias, printed for reference only.
  familyMeanTrain: number;
  // Reference only, NOT used for the headline comparison: the same family
  // mean computed IN-SAMPLE, over every eligible row including the row
  // being scored. This has no leave-one-out penalty, so it is not biased
  // negative the way `familyMeanTrain` is — it exists purely to make that
  // bias visible by showing what the same estimator reads without it.
  familyMeanAll: number;
  // True when computeTitlePrior's family term had no same-family neighbour
  // to average (prior.ts:51-54), so it fell back to the neighbour mean and
  // `familyTermOnly` above equals the neighbour term rather than measuring
  // anything family-specific for this row.
  familyFallback: boolean;
  actual: number;
};

// Retrieval-free: the mean ground truth of each hook family across the
// fold's training rows only (no per-row MMR, no neighbour dependence).
// Rows with a null ground truth cannot contribute to the mean, same
// filtering computeTitlePrior applies internally. A family absent from this
// fold's training set (possible only for the rarest families) falls back to
// the same neutral prior the app itself uses when it has nothing to average.
function familyMeansFromTrain(train: Row[], gt: GroundTruth): Map<string, number> {
  const sums = new Map<string, { sum: number; n: number }>();
  for (const r of train) {
    const v = r[gt];
    if (v === null) continue;
    const e = sums.get(r.hook_family) ?? { sum: 0, n: 0 };
    e.sum += v;
    e.n += 1;
    sums.set(r.hook_family, e);
  }
  const means = new Map<string, number>();
  for (const [family, { sum, n }] of sums) means.set(family, n > 0 ? sum / n : NEUTRAL_PRIOR);
  return means;
}

function runRepeat(rows: Row[], gt: GroundTruth, opts: Options, seed: number): Prediction[] {
  // Rows without a ground truth can train (they are legitimate neighbours,
  // and computeTitlePrior filters nulls out of the mean) but can never test.
  const eligible = rows.filter((r) => r[gt] !== null);
  const groups = groupByTitle(eligible);
  const folds = assignFolds(groups, FOLDS, (g: TitleGroup<Row>) => g.rows[0].hook_family, mulberry32(seed));

  // In-sample reference: same estimator as familyMeanTrain, but computed
  // over every eligible row (no fold held out). Identical across every fold
  // and every row in this repeat, so it is computed once here rather than
  // per fold.
  const familyMeansAll = familyMeansFromTrain(eligible, gt);

  const out: Prediction[] = [];
  for (let f = 0; f < FOLDS; f++) {
    const testRows = rowsInFold(groups, folds, f);
    if (testRows.length === 0) continue;
    const testIds = new Set(testRows.map((r) => r.id));

    const train = rows.filter((r) => !testIds.has(r.id));
    const familyMeansTrain = familyMeansFromTrain(train, gt);
    for (const row of testRows) {
      // One retrieval, multiple scorings — every baseline below reuses the
      // same neighbours and costs only an extra arithmetic pass.
      const neighbors = retrieveNeighbors(row, train, gt);
      const family = row.hook_family as HookFamily;
      const familyFallback = !neighbors.some(
        (n) => n.hook_family === family && n.performance_score !== null,
      );
      out.push({
        row,
        predicted: computeTitlePrior(row.titleVec, family, neighbors, opts.blend),
        familyTermOnly: computeTitlePrior(row.titleVec, family, neighbors, 1),
        familyMeanTrain: familyMeansTrain.get(row.hook_family) ?? NEUTRAL_PRIOR,
        familyMeanAll: familyMeansAll.get(row.hook_family) ?? NEUTRAL_PRIOR,
        familyFallback,
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
    // spearman(x, x) is an algebraic identity of any correctly-ranking
    // implementation — it returns 1.0 regardless of whether pairing is
    // correct, and it never touches runRepeat, folds or retrieval at all.
    // It cannot prove the pairing. These two checks run the real pipeline
    // once and prove pairing instead:
    const preds = runRepeat(rows, gt, opts, opts.seed);
    if (preds.length < 2) throw new Error('sanity: not enough out-of-fold predictions to check pairing');

    // 1. Prediction.actual really belongs to Prediction.row: re-derive the
    //    ground truth from the row object stored alongside it and confirm
    //    the two agree exactly. A wrong-row pairing bug would desynchronise
    //    these two sources even though both ultimately read the same column.
    const pairing = spearman(preds.map((p) => p.actual), preds.map((p) => p.row[gt] as number));
    console.log(`sanity 1/2: Prediction.actual matches Prediction.row[${gt}] -> ${fmt(pairing, 6)} (must be 1.000000)`);
    if (pairing !== 1) throw new Error(`sanity 1/2 FAILED: Prediction.actual is not consistently Prediction.row[${gt}]`);

    // 2. The headline genuinely depends on alignment. Rotate the predicted
    //    values against the fixed actuals — a cheap, fully deterministic way
    //    to break every pairing without touching RNG state — and confirm the
    //    correlation collapses. If it did not collapse, the metric would be
    //    insensitive to which prediction goes with which row, which is
    //    exactly the bug this check exists to catch.
    //
    //    A single rotation by one index is too noisy to threshold reliably:
    //    tried first, it produced -0.141 against a real headline of 0.266 at
    //    --seed 99 — well within one shuffled-baseline SD (~0.077, measured
    //    elsewhere in this file) of zero, but a naive "must be under half the
    //    real value" bound flagged it as a failure anyway. A single rotation
    //    IS just one draw from that same noisy null. Averaging the |correlation|
    //    over several distinct, fixed rotation offsets divides that noise by
    //    roughly sqrt(offsets), the same variance-reduction the permutation
    //    null gets from its 1000 draws, while staying fully deterministic.
    //
    //    The pass/fail threshold is anchored to the null's own scale, NOT to
    //    a fraction of the real headline. A relative threshold (e.g. "under
    //    half of real") couples "the harness is wired correctly" to "the
    //    predictor currently has strong signal" — reachable regimes like
    //    --family-blend 0 or --ground-truth view_outlier_score can weaken the
    //    real headline toward the null's own magnitude, at which point a
    //    relative bound either passes by luck or fails deterministically
    //    while blaming pairing. 3/sqrt(n) is a generous multiple of the
    //    ~1/sqrt(n) scale Spearman's rho has under independence (n here is
    //    out-of-fold predictions, same quantity as the headline's sampling
    //    SE above) — comfortably above ordinary null noise, but requires a
    //    real collapse regardless of how strong or weak the headline is.
    const predicted = preds.map((p) => p.predicted);
    const actual = preds.map((p) => p.actual);
    const real = spearman(predicted, actual);
    const offsets = Array.from({ length: Math.min(10, predicted.length - 1) }, (_, i) => i + 1);
    const rotatedMags = offsets.map((k) => {
      const rotated = [...predicted.slice(k), ...predicted.slice(0, k)];
      const s = spearman(rotated, actual);
      return Math.abs(s ?? 0);
    });
    const brokenMag = rotatedMags.reduce((a, b) => a + b, 0) / rotatedMags.length;
    const threshold = 3 / Math.sqrt(preds.length);
    console.log(`sanity 2/2: real headline ${fmt(real, 6)} vs mean |rotated-pairing headline| ` +
      `${brokenMag.toFixed(6)} over ${offsets.length} fixed rotation offsets ` +
      `(must collapse below ${threshold.toFixed(6)} = 3/sqrt(n), independent of headline strength)`);
    if (real === null || !(brokenMag < threshold)) {
      throw new Error(
        `sanity 2/2 FAILED: mean rotated-pairing magnitude (${brokenMag.toFixed(6)}) did not collapse ` +
        `below the null threshold (${threshold.toFixed(6)}) — the correlation may not depend on alignment`,
      );
    }

    console.log('\nsanity: PASS — pairing is correct and the headline depends on it.');
    return;
  }

  const headline: number[] = [];
  const shuffledBase: number[] = [];
  const familyTermBase: number[] = [];
  const familyMeanBase: number[] = [];
  const familyMeanAllBase: number[] = [];
  const p3: number[] = [];
  const p5: number[] = [];
  const perFamily = new Map<string, { pred: number[]; act: number[] }>();
  let fallbackCount = 0;
  let predictionCount = 0;
  let sampleN = 0;

  for (let rep = 0; rep < opts.repeats; rep++) {
    const seed = opts.seed + rep * 1000;
    const preds = runRepeat(rows, gt, opts, seed);
    const rand = mulberry32(seed ^ 0x5eed);
    sampleN = preds.length; // identical every repeat: every eligible row tested exactly once.

    const predicted = preds.map((p) => p.predicted);
    const actual = preds.map((p) => p.actual);

    const h = spearman(predicted, actual);
    if (h !== null) headline.push(h);

    const ft = spearman(preds.map((p) => p.familyTermOnly), actual);
    if (ft !== null) familyTermBase.push(ft);

    const fm = spearman(preds.map((p) => p.familyMeanTrain), actual);
    if (fm !== null) familyMeanBase.push(fm);

    const fma = spearman(preds.map((p) => p.familyMeanAll), actual);
    if (fma !== null) familyMeanAllBase.push(fma);

    // Permutation null: shuffle predictions against fixed actuals, same
    // distribution, no signal. NULL_DRAWS_PER_REPEAT draws per repeat
    // (1000 total across 5 repeats) — 5 draws badly undercharacterises a
    // null whose own mean has an SE comparable to its value.
    for (let draw = 0; draw < NULL_DRAWS_PER_REPEAT; draw++) {
      const shuf = [...predicted];
      for (let i = shuf.length - 1; i > 0; i--) {
        const j = Math.floor(rand() * (i + 1));
        [shuf[i], shuf[j]] = [shuf[j], shuf[i]];
      }
      const sb = spearman(shuf, actual);
      if (sb !== null) shuffledBase.push(sb);
    }

    p3.push(slateMean(preds, 3, opts.slateSize, mulberry32(seed ^ 0xa11ce)));
    p5.push(slateMean(preds, 5, opts.slateSize, mulberry32(seed ^ 0xb0b)));

    for (const p of preds) {
      const e = perFamily.get(p.row.hook_family) ?? { pred: [], act: [] };
      e.pred.push(p.predicted);
      e.act.push(p.actual);
      perFamily.set(p.row.hook_family, e);
      predictionCount++;
      if (p.familyFallback) fallbackCount++;
    }
  }

  const constant = spearman(eligible.map(() => 0.5), eligible.map((r) => r[gt] as number));

  const h = meanSd(headline);
  const sb = meanSd(shuffledBase);
  const ft = meanSd(familyTermBase);
  const fm = meanSd(familyMeanBase);
  const fma = meanSd(familyMeanAllBase);
  // Analytic SE of Spearman's rho under independence, ~1/sqrt(n-1). This is
  // the dominant source of uncertainty in the headline — roughly 3x h.sd,
  // which only measures sensitivity to fold partition over the SAME 172 rows.
  const samplingSE = 1 / Math.sqrt(sampleN - 1);
  const fallbackFrac = predictionCount > 0 ? fallbackCount / predictionCount : 0;

  console.log('Spearman (headline)      ' +
    `${fmt(h.mean)} (fold-assignment spread ${fmt(h.sd)} across ${opts.repeats} seeds)`);
  console.log(`  sampling SE (n=${sampleN})   ~${samplingSE.toFixed(3)}  ` +
    '(analytic, 1/sqrt(n-1) — the dominant uncertainty, not the spread above)');
  console.log(`  baseline: shuffled (${shuffledBase.length} draws)`.padEnd(42) + `${fmt(sb.mean)} +/- ${fmt(sb.sd)}`);
  console.log('  baseline: family term only (blend=1)     ' + `${fmt(ft.mean)} +/- ${fmt(ft.sd)}`);
  console.log('  baseline: family mean (train, out-of-fold)  ' + `${fmt(fm.mean)} +/- ${fmt(fm.sd)}`);
  console.log('  baseline: family mean (in-sample, reference) ' + `${fmt(fma.mean)} +/- ${fmt(fma.sd)}`);
  console.log('  baseline: constant 0.5                     ' + `${fmt(constant)}   (undefined by construction)`);
  console.log('\n  note: the out-of-fold family-mean baseline above is negatively biased under the null ' +
    'by construction (a leave-fold-out group mean loses variance regardless of whether hook family ' +
    'has any real effect) — only its comparison to the headline is meaningful, not its sign. The ' +
    'in-sample figure is the same estimator without that bias, shown for reference: its positive ' +
    'value is what confirms the out-of-fold negative is the expected leave-out penalty, not a real ' +
    'anti-correlation.');

  console.log(`\nfamily term fallback: ${(fallbackFrac * 100).toFixed(1)}% of predictions ` +
    '(no same-family neighbour retrieved; family term only == neighbour term for these rows)');

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
      `permutation-null baseline (${fmt(sb.mean)} +/- ${fmt(sb.sd)}).`);
    console.log('   The prior is not distinguishable from noise on this corpus. See EVAL.md.');
  }
  if (h.mean <= ft.mean) {
    console.log(`\n!! NOTE: the headline (${fmt(h.mean)}) does not beat "family term only" ` +
      `(${fmt(ft.mean)} +/- ${fmt(ft.sd)}). This compares the neighbour term against the family ` +
      'term of the SAME prior computation (retrieval-dependent, not a retrieval-free baseline) — ' +
      'see "family mean (train)" below for the retrieval-free comparison.');
  }
  if (h.mean <= fm.mean) {
    console.log(`\n!! WARNING: the headline (${fmt(h.mean)}) does not beat the retrieval-free ` +
      `family-mean baseline (${fmt(fm.mean)} +/- ${fmt(fm.sd)}). Description-space retrieval is ` +
      'adding nothing over knowing the hook family.');
  }
}

// A completed report always exits 0: a measurement that fails the build gets
// muted or deleted. An uncaught error here (env missing, corpus load failure,
// or a failed --sanity check) is the one path that exits non-zero.
main().catch((e) => {
  console.error(`\n${(e as Error).message}`);
  process.exit(1);
});
