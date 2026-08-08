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

import fs from 'node:fs';
import { loadEnvLocal, requireEnv } from './lib/load-env';
import { mulberry32, groupByTitle, assignFolds, rowsInFold, type TitleGroup } from './lib/eval-split';
import { spearman, slatePrecisionAtK, meanSd } from './lib/eval-metrics';
import { RPC_LIMIT, FINAL_K, MMR_LAMBDA } from '../lib/retrieval/constants';
import { computeTitlePrior, FAMILY_PRIOR_BLEND, type CorpusNeighbor } from '../lib/retrieval/prior';
import { cosineSimilarity, mmrRerank, type MmrCandidate } from '../lib/retrieval/mmr';
import type { HookFamily } from '../lib/hooks/taxonomy';

const DEFAULT_SEED = 20260804;
const FOLDS = 5;
// Was 5. Raised to 25 on measurement: 5 repeats does not average out fold
// partition noise, so the headline moved with the seed by more than any real
// change would. Measured on the 259-row corpus, seeds 20260804/1/2:
//
//    5 repeats -> 0.263, 0.273, 0.235   (seed-to-seed range 0.038)
//   25 repeats -> 0.261, 0.255, 0.250   (range 0.011)
//   50 repeats -> 0.261, 0.256, 0.246   (range 0.015 — no better than 25)
//
// Convergence plateaus at 25; the residual ~0.01 is genuine and is negligible
// beside the ~0.063 sampling SE at this corpus size. A default that needs a
// flag to be trustworthy is not a default, so this is the shipped value —
// a run costs nothing but time (embeddings are already in Postgres).
const REPEATS = 25;
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
  // Funnel geometry. Defaults come from lib/retrieval/constants so the eval
  // measures the shipped configuration; overriding them is how you find out
  // whether the shipped values are any good. They were chosen by intuition
  // and never tested.
  rpcLimit: number;
  finalK: number;
  mmrLambda: number;
  // Swap description vectors for a locally-computed alternative, to test
  // whether embedding richer text improves retrieval without touching the
  // corpus. JSON: { "<corpus id>": number[] }.
  embeddings: string | null;
};

function parseArgs(argv: string[]): Options {
  const o: Options = {
    seed: DEFAULT_SEED,
    repeats: REPEATS,
    groundTruth: 'performance_score',
    blend: FAMILY_PRIOR_BLEND,
    slateSize: SLATE_SIZE,
    sanity: false,
    rpcLimit: RPC_LIMIT,
    finalK: FINAL_K,
    mmrLambda: MMR_LAMBDA,
    embeddings: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--seed') o.seed = parseInt(argv[++i], 10);
    else if (a === '--repeats') o.repeats = parseInt(argv[++i], 10);
    else if (a === '--slate-size') o.slateSize = parseInt(argv[++i], 10);
    else if (a === '--family-blend') o.blend = Number(argv[++i]);
    else if (a === '--rpc-limit') o.rpcLimit = parseInt(argv[++i], 10);
    else if (a === '--final-k') o.finalK = parseInt(argv[++i], 10);
    else if (a === '--mmr-lambda') o.mmrLambda = Number(argv[++i]);
    else if (a === '--embeddings') o.embeddings = argv[++i];
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
  if (!Number.isInteger(o.rpcLimit) || o.rpcLimit < 1) throw new Error('--rpc-limit requires a positive integer');
  if (!Number.isInteger(o.finalK) || o.finalK < 1) throw new Error('--final-k requires a positive integer');
  if (o.finalK > o.rpcLimit) throw new Error('--final-k cannot exceed --rpc-limit');
  if (!(o.mmrLambda >= 0 && o.mmrLambda <= 1)) throw new Error('--mmr-lambda must be between 0 and 1');
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

  // Re-sort on CONTENT, not on `id`.
  //
  // `order=id` above is required for stable pagination, but corpus_titles.id is
  // `uuid default gen_random_uuid()` and import-dataset.ts replaces the whole
  // table, so every import assigns every row a fresh random id. Row order
  // therefore changed on each import, which changed the seeded fold partition,
  // which moved the headline — with nothing in the data having changed.
  //
  // Measured on the 259-row corpus, varying only the partition: 0.210, 0.243,
  // 0.250, 0.264, 0.266, 0.293 — a range of 0.083, comparable to the headline
  // itself. Three "before/after" comparisons across imports were made before
  // this was found and none of them were distinguishable from this effect.
  //
  // Sorting by (title, hook_family) makes a run a function of the corpus's
  // CONTENT and the seed alone, so two imports of the same data now produce the
  // same number and a genuine change is no longer masked by a reshuffle.
  rows.sort((a, b) => a.title.localeCompare(b.title) || a.hook_family.localeCompare(b.hook_family));
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
function retrieveNeighbors(
  test: Row,
  train: Row[],
  gt: GroundTruth,
  funnel: { rpcLimit: number; finalK: number; mmrLambda: number },
): CorpusNeighbor[] {
  const scored = train.map((t) => ({ row: t, sim: cosineSimilarity(test.descVec, t.descVec) }));
  scored.sort((a, b) => b.sim - a.sim);

  const candidates: MmrCandidate<Row>[] = scored.slice(0, funnel.rpcLimit).map((s) => ({
    item: s.row,
    relevance: s.sim,
    embedding: s.row.titleVec, // MMR diversifies as TITLES, as in the app
  }));

  return mmrRerank(candidates, funnel.finalK, funnel.mmrLambda).map((c) => ({
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
  // fold size.
  //
  // SCALE OF THAT PENALTY: with w_F = N_F/N the N_F cancels, leaving
  // P = (1/N) * sum_F sigma_F^2 * N_F/(N_F-1) ~= k*sigma^2/N. So it is set
  // by the corpus size N and the family count k, NOT by how small the
  // families are; family size enters only through N_F/(N_F-1), which spans
  // 1.02-1.14 on this corpus (a <=14% effect). It shrinks as 1/N, so a
  // bigger corpus does shrink it.
  //
  // NOT UNIQUE TO THIS BASELINE: performance_score is a percentile rank over
  // a fixed population, so every pairwise covariance is -sigma^2/(N-1) and
  // ANY mean over a subset excluding row i carries the same covariance
  // penalty — the headline's neighbour mean included. Subset size does not
  // change it; what differs is the predictor's variance. The headline's
  // 5-row neighbour mean has sd ~0.45*sigma against this family mean's
  // ~0.17*sigma, so in correlation terms the headline's penalty is ~-0.013
  // against this baseline's ~-0.034 — smaller by roughly 60%, not absent.
  // The comparison to the headline is therefore NOT apples-to-apples; read
  // it as directional. See EVAL.md.
  //
  // Because the construction-only null (~-0.034) does not on its own account
  // for the observed value, the eval MEASURES the null rather than asserting
  // it: see `familyLabelNull` below, which permutes hook_family labels across
  // rows and recomputes this exact estimator. `familyMeanAll` is the same
  // estimator with the opposite-signed bias, printed for reference only.
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
//
// `familyOf` exists so the permutation null can recompute this identical
// estimator against shuffled labels without duplicating the arithmetic.
function familyMeansFromTrain(
  train: Row[],
  gt: GroundTruth,
  familyOf: (r: Row) => string = (r) => r.hook_family,
): Map<string, number> {
  const sums = new Map<string, { sum: number; n: number }>();
  for (const r of train) {
    const v = r[gt];
    if (v === null) continue;
    const key = familyOf(r);
    const e = sums.get(key) ?? { sum: 0, n: 0 };
    e.sum += v;
    e.n += 1;
    sums.set(key, e);
  }
  const means = new Map<string, number>();
  for (const [family, { sum, n }] of sums) means.set(family, n > 0 ? sum / n : NEUTRAL_PRIOR);
  return means;
}

// One repeat's fold structure. Extracted so the family-label permutation null
// can reuse the EXACT partition the real baseline was measured on — the null
// must vary only the labels, not the split.
type Fold = { test: Row[]; train: Row[] };

function splitFolds(rows: Row[], gt: GroundTruth, seed: number): Fold[] {
  // Rows without a ground truth can train (they are legitimate neighbours,
  // and computeTitlePrior filters nulls out of the mean) but can never test.
  const eligible = rows.filter((r) => r[gt] !== null);
  const groups = groupByTitle(eligible);
  const assignment = assignFolds(groups, FOLDS, (g: TitleGroup<Row>) => g.rows[0].hook_family, mulberry32(seed));

  const out: Fold[] = [];
  for (let f = 0; f < FOLDS; f++) {
    const test = rowsInFold(groups, assignment, f);
    if (test.length === 0) continue;
    const testIds = new Set(test.map((r) => r.id));
    out.push({ test, train: rows.filter((r) => !testIds.has(r.id)) });
  }
  return out;
}

function runRepeat(rows: Row[], gt: GroundTruth, opts: Options, seed: number): Prediction[] {
  const eligible = rows.filter((r) => r[gt] !== null);

  // In-sample reference: same estimator as familyMeanTrain, but computed
  // over every eligible row (no fold held out). Identical across every fold
  // and every row in this repeat, so it is computed once here rather than
  // per fold.
  const familyMeansAll = familyMeansFromTrain(eligible, gt);

  const out: Prediction[] = [];
  for (const { test: testRows, train } of splitFolds(rows, gt, seed)) {
    const familyMeansTrain = familyMeansFromTrain(train, gt);
    for (const row of testRows) {
      // One retrieval, multiple scorings — every baseline below reuses the
      // same neighbours and costs only an extra arithmetic pass.
      const neighbors = retrieveNeighbors(row, train, gt, opts);
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

// ------------------------------------------------ family-label permutation null

// The measured null for `family mean (train, out-of-fold)`.
//
// The construction penalty derived on Prediction.familyMeanTrain accounts for
// roughly -0.034 of correlation. The observed baseline is several times more
// negative than that. The gap is NOT realized between-family variance: that
// term enters the covariance with a positive sign and so cannot make the
// figure more negative. It is construction the simple derivation under-counts
// — this estimator holds out a whole FOLD, not one row, so every training
// mean is displaced away from the actuals it is scored against. Rather than
// argue about how much that accounts for, measure the null directly.
//
// The null shuffles WHICH ROW CARRIES WHICH hook_family label and recomputes
// the identical estimator. Everything else is held fixed: the same fold
// partition (which stays keyed on the real labels, because that is the
// partition the real baseline was measured on), the same ground truth, the
// same leave-fold-out arithmetic. What is left is the estimator's behaviour
// when hook_family carries no signal — exactly the quantity the observed
// -0.101 needs to be compared against.
//
// No retrieval is involved, so this costs milliseconds.
function familyLabelNull(
  rows: Row[],
  folds: Fold[],
  gt: GroundTruth,
  draws: number,
  rand: () => number,
): number[] {
  const labels = rows.map((r) => r.hook_family);
  const permuted = new Map<string, string>();
  const familyOf = (r: Row) => permuted.get(r.id) as string;

  const out: number[] = [];
  for (let d = 0; d < draws; d++) {
    const perm = [...labels];
    for (let i = perm.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [perm[i], perm[j]] = [perm[j], perm[i]];
    }
    rows.forEach((r, i) => permuted.set(r.id, perm[i]));

    const pred: number[] = [];
    const act: number[] = [];
    for (const { test, train } of folds) {
      const means = familyMeansFromTrain(train, gt, familyOf);
      for (const row of test) {
        pred.push(means.get(familyOf(row)) ?? NEUTRAL_PRIOR);
        act.push(row[gt] as number);
      }
    }
    const s = spearman(pred, act);
    if (s !== null) out.push(s);
  }
  return out;
}

// ---------------------------------------------------------------- reporting

function fmt(x: number | null, places = 3): string {
  return x === null ? '  n/a' : x.toFixed(places);
}

// Slate precision@k for one repeat, alongside its own shuffled null.
//
// The null shuffles the predicted values WITHIN each slate against that
// slate's fixed actuals — the same structure as the headline's permutation
// null, applied per slate. It is what "ranking these 10 at random" actually
// scores on this data, as opposed to the analytic k/size, and it is the only
// way to say whether a 0.571-vs-0.500 gap is an edge or a rounding artefact.
//
// `shufRand` is a SEPARATE stream from `rand` on purpose: drawing shuffle
// randomness from the sampling stream would change which rows land in which
// slate, silently moving the real number the null is supposed to explain.
//
// Returns per-slate score arrays rather than means so the caller can report
// the null's own spread, which is a per-slate quantity.
function slateScores(
  preds: Prediction[],
  k: number,
  size: number,
  rand: () => number,
  shufRand: () => number,
): { real: number[]; shuffled: number[] } {
  if (preds.length < size) throw new Error(`slate size ${size} exceeds ${preds.length} predictions`);
  const real: number[] = [];
  const shuffled: number[] = [];
  for (let s = 0; s < SLATES; s++) {
    const pool = [...preds];
    const slate: Prediction[] = [];
    for (let i = 0; i < size; i++) {
      slate.push(pool.splice(Math.floor(rand() * pool.length), 1)[0]);
    }
    const predicted = slate.map((p) => p.predicted);
    const actual = slate.map((p) => p.actual);
    real.push(slatePrecisionAtK(predicted, actual, k));

    const shuf = [...predicted];
    for (let i = shuf.length - 1; i > 0; i--) {
      const j = Math.floor(shufRand() * (i + 1));
      [shuf[i], shuf[j]] = [shuf[j], shuf[i]];
    }
    shuffled.push(slatePrecisionAtK(shuf, actual, k));
  }
  return { real, shuffled };
}

async function main(): Promise<void> {
  loadEnvLocal();
  requireEnv(['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY']);
  const opts = parseArgs(process.argv.slice(2));

  const rows = await loadCorpus();

  // Optional: score against description vectors built from different source
  // text, to test whether embedding more of the vision output improves
  // retrieval. Both sides of every comparison are swapped, because the eval
  // uses the same column for the held-out query and the training rows — so
  // the space stays internally consistent, exactly as it must in the app.
  if (opts.embeddings) {
    const override = JSON.parse(fs.readFileSync(opts.embeddings, 'utf8')) as Record<string, number[]>;
    let swapped = 0;
    for (const r of rows) {
      const v = override[r.id];
      if (v) {
        r.descVec = v;
        swapped++;
      }
    }
    if (swapped !== rows.length) {
      throw new Error(
        `embedding override covers ${swapped}/${rows.length} rows. It must cover every row, ` +
          `or the comparison mixes two embedding spaces and means nothing.`,
      );
    }
    console.log(`description vectors: overridden from ${opts.embeddings} (${swapped} rows)`);
  }
  const gt = opts.groundTruth;
  const eligible = rows.filter((r) => r[gt] !== null);

  console.log(`eval — ${eligible.length} of ${rows.length} rows scoreable, ` +
    `${FOLDS}-fold x ${opts.repeats} repeats, seed ${opts.seed}`);
  console.log(`ground truth: ${gt}        funnel: top-${opts.rpcLimit} -> MMR(${opts.finalK}, lambda=${opts.mmrLambda})`);
  console.log(`family blend: ${opts.blend}\n`);

  if (opts.sanity) {
    // spearman(x, x) is an algebraic identity of any correctly-ranking
    // implementation — it returns 1.0 regardless of whether pairing is
    // correct, and it never touches runRepeat, folds or retrieval at all.
    // It cannot prove anything. These two checks run the real pipeline once
    // instead. Check 2 is the falsifiable one; check 1 is a regression guard.
    const preds = runRepeat(rows, gt, opts, opts.seed);
    if (preds.length < 2) throw new Error('sanity: not enough out-of-fold predictions to check pairing');

    // 1. REGRESSION GUARD, not a live test. As runRepeat is written today
    //    `row` and `actual` are set in one object literal from the same row
    //    reference, so this cannot fail — it is asserting an invariant that
    //    currently holds by construction. It is here to fail LATER, if a
    //    refactor ever decouples the two (assembling predictions from
    //    parallel arrays, reordering, merging fold outputs by index). Note
    //    it is an exact element-wise equality, not a correlation: Spearman
    //    would return 1.0 for any monotone relationship, so it would pass on
    //    values that are systematically wrong but consistently ordered.
    let mismatches = 0;
    for (const p of preds) if (p.actual !== (p.row[gt] as number)) mismatches++;
    console.log(`sanity 1/2: Prediction.actual === Prediction.row[${gt}] element-wise over ` +
      `${preds.length} predictions -> ${mismatches} mismatches (must be 0; regression guard, ` +
      'cannot fail as runRepeat is written today)');
    if (mismatches > 0) {
      throw new Error(
        `sanity 1/2 FAILED: ${mismatches} of ${preds.length} predictions have an ` +
        `actual that is not Prediction.row[${gt}] — row/actual pairing has been decoupled`,
      );
    }

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
  const familyLabelNullDraws: number[] = [];
  const p3: number[] = [];
  const p5: number[] = [];
  const p3Null: number[] = [];
  const p5Null: number[] = [];
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

    // Measured null for the out-of-fold family-mean baseline: same folds,
    // same estimator, hook_family labels shuffled across rows. Same draw
    // count as the shuffled null above, for the same reason.
    for (const s of familyLabelNull(
      rows,
      splitFolds(rows, gt, seed),
      gt,
      NULL_DRAWS_PER_REPEAT,
      mulberry32(seed ^ 0xfa3111),
    )) {
      familyLabelNullDraws.push(s);
    }

    const s3 = slateScores(preds, 3, opts.slateSize, mulberry32(seed ^ 0xa11ce), mulberry32(seed ^ 0x5171e3));
    const s5 = slateScores(preds, 5, opts.slateSize, mulberry32(seed ^ 0xb0b), mulberry32(seed ^ 0x5171e5));
    p3.push(meanSd(s3.real).mean);
    p5.push(meanSd(s5.real).mean);
    p3Null.push(...s3.shuffled);
    p5Null.push(...s5.shuffled);

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
  const fln = meanSd(familyLabelNullDraws);
  // How far the observed out-of-fold family-mean baseline sits from its own
  // measured null, in that null's SDs. Inside ~2 SD means the value is fully
  // explained by how this estimator behaves when hook_family carries no
  // signal; outside means hook family is measurably anti-predictive
  // out-of-fold.
  const flZ = fln.sd > 0 ? (fm.mean - fln.mean) / fln.sd : 0;
  const flInside = Math.abs(flZ) <= 2;
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
  console.log(`    permuted-family null (${familyLabelNullDraws.length} draws)`.padEnd(45) +
    `${fmt(fln.mean)} +/- ${fmt(fln.sd)}   ` +
    `(observed is ${flZ >= 0 ? '+' : ''}${flZ.toFixed(2)} SD from it — ` +
    `${flInside ? 'INSIDE the null' : 'OUTSIDE the null'})`);
  console.log('  baseline: family mean (in-sample, reference) ' + `${fmt(fma.mean)} +/- ${fmt(fma.sd)}`);
  console.log('  baseline: constant 0.5                     ' + `${fmt(constant)}   (undefined by construction)`);
  console.log('\n  note: the out-of-fold family-mean baseline is negatively biased under the null by ' +
    'construction (a leave-fold-out group mean loses covariance whether or not hook family has any ' +
    'real effect; the penalty is ~k*sigma^2/N, set by corpus size and family count). The permuted-family ' +
    'null above measures that bias directly, by reshuffling which row carries which hook_family label ' +
    (flInside
      ? 'and rerunning the same estimator: the observed value sits inside it, so the negative sign is ' +
        'construction plus chance, not evidence about the taxonomy. '
      : 'and rerunning the same estimator: the observed value sits OUTSIDE it, so hook family is mildly ' +
        'anti-predictive out-of-fold on this corpus beyond what construction explains. ') +
    'The headline carries a smaller analogous penalty (every subset mean excluding row i does, on a ' +
    'percentile-rank ground truth) — smaller because the prior\'s predictor varies far more than a ' +
    'family mean does — so the two are directional, not a clean margin. The in-sample figure is the ' +
    'same estimator with the opposite bias. See EVAL.md.');

  console.log(`\nfamily term fallback: ${(fallbackFrac * 100).toFixed(1)}% of predictions ` +
    '(no same-family neighbour retrieved; family term only == neighbour term for these rows)');

  const m3 = meanSd(p3);
  const m5 = meanSd(p5);
  const n3 = meanSd(p3Null);
  const n5 = meanSd(p5Null);
  console.log(`\nslate precision (${opts.slateSize} candidates, ${SLATES} slates x ${opts.repeats} repeats)`);
  const slateLine = (k: number, m: { mean: number; sd: number }, n: { mean: number; sd: number }, draws: number) =>
    `  @${k}   ${fmt(m.mean)} +/- ${fmt(m.sd)} across repeats   ` +
    `(random ${(k / opts.slateSize).toFixed(3)}; shuffled null ${fmt(n.mean)} +/- ${fmt(n.sd)} per slate, ` +
    `SE of null mean ${(n.sd / Math.sqrt(draws)).toFixed(3)})`;
  console.log(slateLine(3, m3, n3, p3Null.length));
  console.log(slateLine(5, m5, n5, p5Null.length));
  console.log('    the +/- across repeats is spread over 5 fold partitions of the SAME rows and the ' +
    'null\'s SE assumes slates are independent when they resample one 172-row pool — both understate ' +
    'uncertainty. Read the gap against the null as a direction, not a measured effect size.');

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
    console.log(`\n!! WARNING: the headline (${fmt(h.mean)}) does not beat the out-of-fold ` +
      `family-mean baseline (${fmt(fm.mean)} +/- ${fmt(fm.sd)}), even though that baseline is itself ` +
      'biased low by construction (see EVAL.md). This is a stronger warning sign than the raw numbers ' +
      'suggest and is worth investigating directly — it does not by itself establish that ' +
      'description-space retrieval adds nothing over hook family.');
  }
}

// A completed report always exits 0: a measurement that fails the build gets
// muted or deleted. An uncaught error here (env missing, corpus load failure,
// or a failed --sanity check) is the one path that exits non-zero.
main().catch((e) => {
  console.error(`\n${(e as Error).message}`);
  process.exit(1);
});
