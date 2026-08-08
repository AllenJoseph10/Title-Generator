// Does classifyCandidates() actually identify the right hook family?
//
// The generation prompt tells the model: "REQUIRED hook families (you MUST
// include at least one title for each)". That list comes from
// classifyCandidates(), a keyword matcher over vibe + visualHook which returns
// AT LEAST 3 of the 5 families and tops up arbitrarily when fewer match.
//
// So >=3 of every 10 generated titles are structurally mandated by this
// function. Nothing has ever measured whether its picks are right — and since
// the app now shows only the best 5 of 10, a mandated poor-fit title can
// displace a good one.
//
// This audit runs the real function against the 175 corpus rows, whose true
// hook_family was labelled by a separate Claude pass during import. Zero API
// cost: every input is already on disk.
//
// Run: npx tsx scripts/audit-family-selector.ts

import fs from 'node:fs';
import path from 'node:path';
import { classifyCandidates, familiesFromNeighbours } from '../lib/hooks/classify';
import { HOOK_FAMILIES, HOOK_TAXONOMY, type HookFamily } from '../lib/hooks/taxonomy';
import { cosineSimilarity, mmrRerank, type MmrCandidate } from '../lib/retrieval/mmr';
import { RPC_LIMIT, FINAL_K, MMR_LAMBDA } from '../lib/retrieval/constants';
import { loadEnvLocal } from './lib/load-env';

type Fields = { scene: string; subject: string; setting: string; vibe: string[]; visualHook: string };
type Item = { permalink?: string; descriptionFields?: Fields; burnedInTitle?: string };
type Label = { hook_family: string; confidence: string; title: string };

const RAW = path.join(process.cwd(), 'datasets', 'raw');

function loadRows(): Array<{ url: string; fields: Fields; label: Label }> {
  const cache = JSON.parse(
    fs.readFileSync(path.join(RAW, '_hook-families.json'), 'utf8'),
  ) as Record<string, Label>;

  const rows: Array<{ url: string; fields: Fields; label: Label }> = [];
  for (const dir of fs.readdirSync(RAW, { withFileTypes: true })) {
    if (!dir.isDirectory()) continue;
    const p = path.join(RAW, dir.name, 'manifest.json');
    if (!fs.existsSync(p)) continue;
    const parsed = JSON.parse(fs.readFileSync(p, 'utf8'));
    const items: Item[] = Array.isArray(parsed)
      ? parsed
      : ((parsed.items as Item[]) ?? (Object.values(parsed).find(Array.isArray) as Item[]) ?? []);
    for (const it of items) {
      if (!it.permalink || !it.descriptionFields || !it.burnedInTitle) continue;
      const label = cache[it.permalink];
      if (!label) continue;
      rows.push({ url: it.permalink, fields: it.descriptionFields, label });
    }
  }
  return rows;
}

function main() {
  const rows = loadRows();
  console.log(`rows audited: ${rows.length}\n`);

  let hits = 0;
  let fellBack = 0;
  let totalReturned = 0;
  const sizeHist = new Map<number, number>();
  const perFamily = new Map<string, { n: number; hit: number }>();
  const misses: Array<{ title: string; truth: string; got: string[] }> = [];

  for (const r of rows) {
    const picked = classifyCandidates(r.fields.vibe, r.fields.visualHook);
    const truth = r.label.hook_family;
    const hit = picked.includes(truth as never);

    if (hit) hits++;
    totalReturned += picked.length;
    sizeHist.set(picked.length, (sizeHist.get(picked.length) ?? 0) + 1);

    // The selector "tops up" to 3 when fewer than 3 families had ANY keyword
    // match. Reproduce that condition to see how often the list is padding
    // rather than signal.
    const haystack = [...r.fields.vibe, r.fields.visualHook].join(' ').toLowerCase();
    const genuine = HOOK_FAMILIES.filter((id) =>
      HOOK_TAXONOMY[id].triggers.some((t) => haystack.includes(t.toLowerCase())),
    ).length;
    if (genuine < 3) fellBack++;

    const e = perFamily.get(truth) ?? { n: 0, hit: 0 };
    e.n++;
    if (hit) e.hit++;
    perFamily.set(truth, e);

    if (!hit && misses.length < 8) {
      misses.push({ title: r.label.title, truth, got: picked });
    }
  }

  const n = rows.length;
  const avgReturned = totalReturned / n;
  const hitRate = hits / n;

  // If the selector returned k of 5 families at random, the true family would
  // land inside by chance with probability k/5. That is the bar to beat.
  const randomBar = avgReturned / HOOK_FAMILIES.length;

  console.log('=== does the required-families list contain the true family? ===');
  console.log(`hit rate            : ${(hitRate * 100).toFixed(1)}%  (${hits}/${n})`);
  console.log(`avg families forced : ${avgReturned.toFixed(2)} of ${HOOK_FAMILIES.length}`);
  console.log(`random baseline     : ${(randomBar * 100).toFixed(1)}%  (picking that many at random)`);
  console.log(`lift over random    : ${((hitRate - randomBar) * 100).toFixed(1)} points`);

  console.log('\n=== how much of the list is padding? ===');
  console.log(`rows where fewer than 3 families matched any keyword: ${fellBack}/${n} (${((fellBack / n) * 100).toFixed(1)}%)`);
  console.log('   (on these, the list is topped up in fixed taxonomy order, not by fit)');

  console.log('\n=== families returned per row ===');
  for (const [size, count] of [...sizeHist.entries()].sort((a, b) => a[0] - b[0])) {
    console.log(`  ${size} families : ${count} rows`);
  }

  console.log('\n=== hit rate by true family ===');
  for (const [fam, e] of [...perFamily.entries()].sort((a, b) => b[1].n - a[1].n)) {
    console.log(`  ${fam.padEnd(24)}n=${String(e.n).padEnd(5)}${((e.hit / e.n) * 100).toFixed(0)}%`);
  }

  console.log('\n=== sample misses (true family NOT in the required list) ===');
  for (const m of misses) {
    console.log(`  "${m.title.slice(0, 58)}"`);
    console.log(`     truth: ${m.truth}   forced: ${m.got.join(', ')}`);
  }

  return { hitRate, avgReturned, randomBar };
}

// ---------------------------------------------------------------- leave-one-out
//
// The replacement derives required families from the videos retrieval actually
// found similar, so it can only be measured by running retrieval. Leave-one-out
// over the corpus does that honestly: hide each row, retrieve its 8 nearest
// neighbours through the real funnel, derive families, and check whether the
// hidden row's true family came through.
//
// Zero API cost — every embedding is already in the database.

type CorpusRow = {
  id: string;
  source_url: string;
  hook_family: string;
  embedding: number[] | string;
  description_embedding: number[] | string | null;
};

const vec = (v: number[] | string): number[] => (typeof v === 'string' ? JSON.parse(v) : v);

async function leaveOneOut(baseline: { hitRate: number; avgReturned: number }) {
  loadEnvLocal();
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    console.log('\n(skipping leave-one-out: SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set)');
    return;
  }
  const headers = { apikey: key, authorization: `Bearer ${key}` };

  const rows: CorpusRow[] = [];
  for (let off = 0; ; off += 25) {
    const res = await fetch(
      `${url}/rest/v1/corpus_titles?select=id,source_url,hook_family,embedding,description_embedding&order=id&offset=${off}&limit=25`,
      { headers },
    );
    const page = (await res.json()) as CorpusRow[];
    if (!page.length) break;
    rows.push(...page);
    if (page.length < 25) break;
  }

  const usable = rows.filter((r) => r.description_embedding);
  let hits = 0;
  let returned = 0;
  const perFamily = new Map<string, { n: number; hit: number }>();

  for (const target of usable) {
    const others = usable.filter((r) => r.id !== target.id);
    const scored = others
      .map((r) => ({ row: r, sim: cosineSimilarity(vec(target.description_embedding!), vec(r.description_embedding!)) }))
      .sort((a, b) => b.sim - a.sim);

    const candidates: MmrCandidate<CorpusRow>[] = scored.slice(0, RPC_LIMIT).map((s) => ({
      item: s.row,
      relevance: s.sim,
      embedding: vec(s.row.embedding),
    }));
    const neighbours = mmrRerank(candidates, FINAL_K, MMR_LAMBDA).map((c) => ({
      hookFamily: c.item.hook_family as HookFamily,
    }));

    const picked = familiesFromNeighbours(neighbours);
    returned += picked.length;
    const hit = picked.includes(target.hook_family as HookFamily);
    if (hit) hits++;

    const e = perFamily.get(target.hook_family) ?? { n: 0, hit: 0 };
    e.n++;
    if (hit) e.hit++;
    perFamily.set(target.hook_family, e);
  }

  const n = usable.length;
  const hitRate = hits / n;
  const avgReturned = returned / n;
  const randomBar = avgReturned / HOOK_FAMILIES.length;

  console.log('\n\n================ REPLACEMENT: familiesFromNeighbours ================');
  console.log(`leave-one-out over ${n} rows, real funnel (top-${RPC_LIMIT} -> MMR(${FINAL_K}, ${MMR_LAMBDA}))\n`);
  console.log(`hit rate            : ${(hitRate * 100).toFixed(1)}%  (${hits}/${n})`);
  console.log(`avg families forced : ${avgReturned.toFixed(2)} of ${HOOK_FAMILIES.length}`);
  console.log(`random baseline     : ${(randomBar * 100).toFixed(1)}%  (picking that many at random)`);
  console.log(`lift over random    : ${((hitRate - randomBar) * 100).toFixed(1)} points`);

  console.log('\n=== hit rate by true family ===');
  for (const [fam, e] of [...perFamily.entries()].sort((a, b) => b[1].n - a[1].n)) {
    console.log(`  ${fam.padEnd(24)}n=${String(e.n).padEnd(5)}${((e.hit / e.n) * 100).toFixed(0)}%`);
  }

  console.log('\n=== head to head ===');
  console.log(`  keyword selector : ${(baseline.hitRate * 100).toFixed(1)}% hit, ${baseline.avgReturned.toFixed(2)} families forced`);
  console.log(`  from neighbours  : ${(hitRate * 100).toFixed(1)}% hit, ${avgReturned.toFixed(2)} families forced`);
  console.log(
    `  change           : ${((hitRate - baseline.hitRate) * 100 >= 0 ? '+' : '')}${((hitRate - baseline.hitRate) * 100).toFixed(1)} points`,
  );
}

(async () => {
  const baseline = main();
  await leaveOneOut(baseline);
})();
