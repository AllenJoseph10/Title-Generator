// Seed niches + corpus titles with OpenAI embeddings. Idempotent.
// Run with: node scripts/seed-corpus.mjs

import fs from 'node:fs';
import path from 'node:path';
import { NICHES, LUXURY_MENSWEAR, LIFESTYLE, FINANCE } from '../seed/corpus.mjs';

const envText = fs.readFileSync(path.join(process.cwd(), '.env.local'), 'utf8');
const env = {};
for (const l of envText.split('\n')) {
  const m = l.match(/^([A-Z_]+)=(.*)$/);
  if (m) env[m[1]] = m[2];
}
for (const k of ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'OPENAI_API_KEY']) {
  if (!env[k]) { console.error(`missing ${k}`); process.exit(1); }
}

const sbHeaders = {
  apikey: env.SUPABASE_SERVICE_ROLE_KEY,
  authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
  'content-type': 'application/json',
};

const BY_NICHE = {
  'luxury-menswear': LUXURY_MENSWEAR,
  lifestyle: LIFESTYLE,
  finance: FINANCE,
};

async function embed(texts) {
  const out = [];
  const BATCH = 64;
  for (let i = 0; i < texts.length; i += BATCH) {
    const slice = texts.slice(i, i + BATCH);
    const r = await fetch('https://api.openai.com/v1/embeddings', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${env.OPENAI_API_KEY}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ model: 'text-embedding-3-small', input: slice }),
    });
    if (!r.ok) throw new Error(`embed batch ${i}: ${r.status} ${await r.text()}`);
    const json = await r.json();
    for (const d of json.data) out.push(d.embedding);
    console.log(`  embedded ${Math.min(i + BATCH, texts.length)}/${texts.length}`);
  }
  return out;
}

async function upsertNiches() {
  const r = await fetch(`${env.SUPABASE_URL}/rest/v1/niches`, {
    method: 'POST',
    headers: { ...sbHeaders, prefer: 'resolution=merge-duplicates,return=representation' },
    body: JSON.stringify(NICHES),
  });
  if (!r.ok) throw new Error(`niches: ${r.status} ${await r.text()}`);
  console.log(`niches upserted: ${NICHES.length}`);
}

async function existingCount(nicheId) {
  const r = await fetch(
    `${env.SUPABASE_URL}/rest/v1/corpus_titles?niche_id=eq.${nicheId}&select=id`,
    { headers: { ...sbHeaders, prefer: 'count=exact' } },
  );
  const range = r.headers.get('content-range') ?? '';
  const total = parseInt(range.split('/')[1] ?? '0', 10);
  return total;
}

async function insertCorpus(nicheId, rows, embeddings) {
  const payload = rows.map((row, i) => ({
    niche_id: nicheId,
    title: row.title,
    hook_family: row.hook_family,
    save_rate_estimate: row.save_rate_estimate,
    source_platform: row.source_platform,
    embedding: embeddings[i],
  }));
  const r = await fetch(`${env.SUPABASE_URL}/rest/v1/corpus_titles`, {
    method: 'POST',
    headers: sbHeaders,
    body: JSON.stringify(payload),
  });
  if (!r.ok) throw new Error(`insert ${nicheId}: ${r.status} ${await r.text()}`);
  console.log(`  inserted ${rows.length} rows for ${nicheId}`);
}

await upsertNiches();

let totalNew = 0;
for (const nicheId of Object.keys(BY_NICHE)) {
  const rows = BY_NICHE[nicheId];
  const have = await existingCount(nicheId);
  if (have >= rows.length) {
    console.log(`${nicheId}: already has ${have} rows, skipping`);
    continue;
  }
  console.log(`${nicheId}: ${rows.length} rows to embed`);
  const embeds = await embed(rows.map((r) => r.title));
  await insertCorpus(nicheId, rows, embeds);
  totalNew += rows.length;
}
console.log(`\nDone. New rows inserted: ${totalNew}`);
