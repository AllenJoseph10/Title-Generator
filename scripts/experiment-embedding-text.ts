// Does retrieval improve if we embed more of the vision output?
//
// The vision step produces five fields — scene, subject, setting, vibe,
// visualHook — but only two reach the embedding. orchestrator.ts builds the
// query as `scene + " " + visualHook`, and describe-videos.ts built the corpus
// side the same way, so the two spaces match. subject and setting are computed,
// stored in the manifests, and then discarded for matching.
//
// This builds alternative description vectors from richer text and writes them
// to disk, so `npm run eval -- --embeddings <file>` can score them. Both sides
// of the comparison are swapped together, because the eval uses one column for
// the held-out query and the training rows — the space stays internally
// consistent, exactly as it must in the app.
//
// Must run via `--conditions=react-server`: lib/providers/openai/embedding is
// marked server-only, and reusing the app's own module keeps these vectors in
// the same model and dimensions as the ones already in the corpus.
//
// Run: npx tsx --conditions=react-server scripts/experiment-embedding-text.ts

import fs from 'node:fs';
import path from 'node:path';
import { loadEnvLocal, requireEnv } from './lib/load-env';

type Fields = { scene: string; subject: string; setting: string; vibe: string[]; visualHook: string };

const OUT_DIR = path.join(process.cwd(), 'datasets', 'raw', '_embedding-variants');
const EMBED_BATCH = 100;

// The control reproduces exactly what the corpus already holds. If it does not
// land on the shipped headline, the join or the source text is wrong and no
// other variant here can be trusted.
const VARIANTS: Record<string, (f: Fields) => string> = {
  'control-scene-hook': (f) => `${f.scene} ${f.visualHook}`,
  'plus-subject-setting': (f) => `${f.scene} ${f.subject} ${f.setting} ${f.visualHook}`,
  'plus-vibe': (f) => `${f.scene} ${f.subject} ${f.setting} ${f.vibe.join(' ')} ${f.visualHook}`,
  'hook-only': (f) => f.visualHook,
  'scene-only': (f) => f.scene,
};

function loadFieldsByUrl(): Map<string, Fields> {
  const RAW = path.join(process.cwd(), 'datasets', 'raw');
  const out = new Map<string, Fields>();
  for (const d of fs.readdirSync(RAW, { withFileTypes: true })) {
    if (!d.isDirectory()) continue;
    const p = path.join(RAW, d.name, 'manifest.json');
    if (!fs.existsSync(p)) continue;
    const parsed = JSON.parse(fs.readFileSync(p, 'utf8'));
    const items: Array<{ permalink?: string; descriptionFields?: Fields }> = Array.isArray(parsed)
      ? parsed
      : (parsed.items ?? Object.values(parsed).find(Array.isArray) ?? []);
    for (const it of items) {
      if (it.permalink && it.descriptionFields) out.set(it.permalink, it.descriptionFields);
    }
  }
  return out;
}

async function main() {
  loadEnvLocal();
  requireEnv(['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'OPENAI_API_KEY']);
  const url = process.env.SUPABASE_URL!;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY!;
  const headers = { apikey: key, authorization: `Bearer ${key}` };

  const corpus: Array<{ id: string; source_url: string }> = [];
  for (let off = 0; ; off += 25) {
    const res = await fetch(
      `${url}/rest/v1/corpus_titles?select=id,source_url&order=id&offset=${off}&limit=25`,
      { headers },
    );
    const page = (await res.json()) as Array<{ id: string; source_url: string }>;
    if (!page.length) break;
    corpus.push(...page);
    if (page.length < 25) break;
  }

  const fieldsByUrl = loadFieldsByUrl();
  const joined = corpus
    .map((c) => ({ id: c.id, fields: fieldsByUrl.get(c.source_url) }))
    .filter((x): x is { id: string; fields: Fields } => !!x.fields);

  console.log(`corpus rows: ${corpus.length}`);
  console.log(`joined to manifest description fields: ${joined.length}`);
  if (joined.length !== corpus.length) {
    // The eval refuses a partial override, so stop here rather than writing
    // files that cannot be used.
    throw new Error(
      `${corpus.length - joined.length} rows have no manifest fields. Every row must join, ` +
        `or the override mixes two embedding spaces.`,
    );
  }

  const { embedMany } = await import('../lib/providers/openai/embedding');
  fs.mkdirSync(OUT_DIR, { recursive: true });

  let totalCost = 0;
  for (const [name, build] of Object.entries(VARIANTS)) {
    const texts = joined.map((j) => build(j.fields).replace(/\s+/g, ' ').trim().slice(0, 8000));
    const avgChars = Math.round(texts.reduce((s, t) => s + t.length, 0) / texts.length);

    const vectors: number[][] = [];
    let cost = 0;
    for (let i = 0; i < texts.length; i += EMBED_BATCH) {
      const batch = await embedMany(texts.slice(i, i + EMBED_BATCH));
      for (const b of batch) {
        vectors.push(b.vector);
        cost += b.costUsd;
      }
    }
    totalCost += cost;

    const map: Record<string, number[]> = {};
    joined.forEach((j, i) => { map[j.id] = vectors[i]; });
    const file = path.join(OUT_DIR, `${name}.json`);
    fs.writeFileSync(file, JSON.stringify(map));
    console.log(`  ${name.padEnd(22)} avg ${String(avgChars).padStart(5)} chars  $${cost.toFixed(6)}  -> ${path.relative(process.cwd(), file)}`);
  }

  console.log(`\ntotal embedding cost: $${totalCost.toFixed(6)}`);
  console.log(`\nnow run, for each variant:`);
  console.log(`  npm run eval -- --embeddings datasets/raw/_embedding-variants/<name>.json`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
