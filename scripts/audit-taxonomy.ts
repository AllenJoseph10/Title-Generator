// Do the five hook families correspond to any real structure in the titles?
//
// The taxonomy in lib/hooks/taxonomy.ts was designed BEFORE the corpus
// existed. It feeds three things: the few-shot example labels, the
// required-families constraint, and 30% of computeTitlePrior. If the
// categories are imposed rather than discovered, all three carry that noise.
//
// Circumstantial evidence that they might be: 90 of 175 titles were
// force-fitted with low confidence at import, and the eval's per-family
// Spearman ranges from 0.023 (setup_trivial_reveal, n=47) to 0.411
// (reaction_humblebrag, n=34).
//
// This clusters the title embeddings already in corpus_titles.embedding and
// measures how much the human taxonomy agrees with the structure the titles
// actually have. Zero API cost.
//
// Run: npx tsx scripts/audit-taxonomy.ts

import fs from 'node:fs';
import path from 'node:path';
import { loadEnvLocal, requireEnv } from './lib/load-env';
import { mulberry32 } from './lib/eval-split';
import { cosineSimilarity } from '../lib/retrieval/mmr';
import { HOOK_FAMILIES } from '../lib/hooks/taxonomy';

const RESTARTS = 12;
const ITERS = 60;
const SEED = 20260804;

type Row = { id: string; title: string; hook_family: string; source_url: string; vec: number[] };

const toVec = (v: number[] | string): number[] => (typeof v === 'string' ? JSON.parse(v) : v);

function normalise(v: number[]): number[] {
  const n = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  return n === 0 ? v : v.map((x) => x / n);
}

// Spherical k-means: on unit vectors, euclidean k-means is equivalent to
// maximising cosine similarity, which is the space these embeddings live in.
function kmeans(vecs: number[][], k: number, rand: () => number) {
  const dim = vecs[0].length;
  let best: { labels: number[]; inertia: number } | null = null;

  for (let restart = 0; restart < RESTARTS; restart++) {
    // k-means++ seeding
    const centres: number[][] = [vecs[Math.floor(rand() * vecs.length)]];
    while (centres.length < k) {
      const d2 = vecs.map((v) => {
        const best = Math.max(...centres.map((c) => cosineSimilarity(v, c)));
        const dist = 1 - best;
        return dist * dist;
      });
      const total = d2.reduce((s, x) => s + x, 0);
      let r = rand() * total;
      let idx = 0;
      while (idx < d2.length - 1 && (r -= d2[idx]) > 0) idx++;
      centres.push(vecs[idx]);
    }

    let labels = new Array<number>(vecs.length).fill(0);
    for (let it = 0; it < ITERS; it++) {
      let moved = false;
      for (let i = 0; i < vecs.length; i++) {
        let bestC = 0;
        let bestS = -Infinity;
        for (let c = 0; c < k; c++) {
          const s = cosineSimilarity(vecs[i], centres[c]);
          if (s > bestS) { bestS = s; bestC = c; }
        }
        if (labels[i] !== bestC) { labels[i] = bestC; moved = true; }
      }
      for (let c = 0; c < k; c++) {
        const members = vecs.filter((_, i) => labels[i] === c);
        if (!members.length) continue;
        const mean = new Array<number>(dim).fill(0);
        for (const m of members) for (let d = 0; d < dim; d++) mean[d] += m[d];
        centres[c] = normalise(mean.map((x) => x / members.length));
      }
      if (!moved) break;
    }

    const inertia = vecs.reduce((s, v, i) => s + (1 - cosineSimilarity(v, centres[labels[i]])), 0);
    if (!best || inertia < best.inertia) best = { labels, inertia };
  }
  return best!;
}

const choose2 = (n: number) => (n * (n - 1)) / 2;

// Adjusted Rand Index: agreement between two partitions, corrected for chance.
// 0 means "no better than random agreement", 1 means identical.
function adjustedRandIndex(a: number[], b: number[]): number {
  const table = new Map<string, number>();
  const aCount = new Map<number, number>();
  const bCount = new Map<number, number>();
  for (let i = 0; i < a.length; i++) {
    const key = `${a[i]}|${b[i]}`;
    table.set(key, (table.get(key) ?? 0) + 1);
    aCount.set(a[i], (aCount.get(a[i]) ?? 0) + 1);
    bCount.set(b[i], (bCount.get(b[i]) ?? 0) + 1);
  }
  const n = a.length;
  const index = [...table.values()].reduce((s, x) => s + choose2(x), 0);
  const sa = [...aCount.values()].reduce((s, x) => s + choose2(x), 0);
  const sb = [...bCount.values()].reduce((s, x) => s + choose2(x), 0);
  const expected = (sa * sb) / choose2(n);
  const max = 0.5 * (sa + sb);
  return max === expected ? 0 : (index - expected) / (max - expected);
}

function purity(clusters: number[], labels: number[], k: number): number {
  let correct = 0;
  for (let c = 0; c < k; c++) {
    const counts = new Map<number, number>();
    for (let i = 0; i < clusters.length; i++) {
      if (clusters[i] !== c) continue;
      counts.set(labels[i], (counts.get(labels[i]) ?? 0) + 1);
    }
    if (counts.size) correct += Math.max(...counts.values());
  }
  return correct / clusters.length;
}

async function main() {
  loadEnvLocal();
  requireEnv(['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY']);
  const url = process.env.SUPABASE_URL!;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY!;
  const headers = { apikey: key, authorization: `Bearer ${key}` };

  const rows: Row[] = [];
  for (let off = 0; ; off += 25) {
    const res = await fetch(
      `${url}/rest/v1/corpus_titles?select=id,title,hook_family,source_url,embedding&order=id&offset=${off}&limit=25`,
      { headers },
    );
    const page = (await res.json()) as Array<Omit<Row, 'vec'> & { embedding: number[] | string }>;
    if (!page.length) break;
    for (const p of page) rows.push({ ...p, vec: normalise(toVec(p.embedding)) });
    if (page.length < 25) break;
  }
  console.log(`titles clustered: ${rows.length}\n`);

  const famIndex = new Map(HOOK_FAMILIES.map((f, i) => [f as string, i]));
  const truth = rows.map((r) => famIndex.get(r.hook_family) ?? -1);
  const vecs = rows.map((r) => r.vec);

  console.log('=== how well does each k agree with the human taxonomy? ===');
  console.log('  k    ARI     purity   (ARI: 0 = chance agreement, 1 = identical)');
  let atFive: { labels: number[]; inertia: number } | null = null;
  for (let k = 2; k <= 8; k++) {
    const km = kmeans(vecs, k, mulberry32(SEED + k));
    const ari = adjustedRandIndex(km.labels, truth);
    const pur = purity(km.labels, truth, k);
    console.log(`  ${String(k).padEnd(5)}${ari.toFixed(3).padStart(6)}   ${pur.toFixed(3)}`);
    if (k === 5) atFive = km;
  }

  // Chance floor: shuffle the taxonomy labels and re-measure.
  const rand = mulberry32(SEED ^ 0xbeef);
  const shuffled = [...truth];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  console.log(`\n  shuffled-label floor at k=5: ARI ${adjustedRandIndex(atFive!.labels, shuffled).toFixed(3)}`);

  console.log('\n=== k=5 clusters vs the five declared families ===');
  const k = 5;
  const header = HOOK_FAMILIES.map((f) => f.slice(0, 9).padStart(10)).join('');
  console.log(`  cluster${header}   size  dominant family (share)`);
  for (let c = 0; c < k; c++) {
    const counts = new Array<number>(HOOK_FAMILIES.length).fill(0);
    let size = 0;
    for (let i = 0; i < rows.length; i++) {
      if (atFive!.labels[i] !== c) continue;
      counts[truth[i]]++;
      size++;
    }
    if (!size) continue;
    const top = counts.indexOf(Math.max(...counts));
    const cells = counts.map((n) => String(n).padStart(10)).join('');
    console.log(`  ${String(c).padEnd(7)}${cells}   ${String(size).padStart(4)}  ${HOOK_FAMILIES[top]} (${((counts[top] / size) * 100).toFixed(0)}%)`);
  }

  console.log('\n=== what actually groups together? (3 titles per cluster) ===');
  for (let c = 0; c < k; c++) {
    const members = rows.filter((_, i) => atFive!.labels[i] === c);
    if (!members.length) continue;
    console.log(`\n  cluster ${c}  (${members.length} titles)`);
    for (const m of members.slice(0, 3)) {
      console.log(`    [${m.hook_family.padEnd(20)}] ${m.title.slice(0, 62)}`);
    }
  }

  // Do the low-confidence labels disagree with the clusters more often?
  const cachePath = path.join(process.cwd(), 'datasets', 'raw', '_hook-families.json');
  if (fs.existsSync(cachePath)) {
    const cache = JSON.parse(fs.readFileSync(cachePath, 'utf8')) as Record<string, { confidence: string }>;
    const dominant = new Map<number, number>();
    for (let c = 0; c < k; c++) {
      const counts = new Map<number, number>();
      for (let i = 0; i < rows.length; i++) {
        if (atFive!.labels[i] !== c) continue;
        counts.set(truth[i], (counts.get(truth[i]) ?? 0) + 1);
      }
      if (counts.size) dominant.set(c, [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0]);
    }
    let loN = 0, loAgree = 0, hiN = 0, hiAgree = 0;
    for (let i = 0; i < rows.length; i++) {
      const conf = cache[rows[i].source_url]?.confidence;
      if (!conf) continue;
      const agrees = dominant.get(atFive!.labels[i]) === truth[i];
      if (conf === 'low') { loN++; if (agrees) loAgree++; }
      else { hiN++; if (agrees) hiAgree++; }
    }
    console.log('\n=== do the low-confidence labels sit where the clusters expect? ===');
    console.log(`  high-confidence: ${hiAgree}/${hiN} agree with their cluster's dominant family (${((hiAgree / hiN) * 100).toFixed(0)}%)`);
    console.log(`  low-confidence : ${loAgree}/${loN} agree (${((loAgree / loN) * 100).toFixed(0)}%)`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
