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
    const testRows = rowsInFold(groups, folds, f);
    if (testRows.length === 0) continue;
    const testIds = new Set(testRows.map((r) => r.id));

    const train = rows.filter((r) => !testIds.has(r.id));
    for (const row of testRows) {
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
