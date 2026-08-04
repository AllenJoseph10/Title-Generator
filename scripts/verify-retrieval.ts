// Smoke test for description-space retrieval (migration 0003).
//
// Usage: npm run verify:retrieval
//
// Takes a few corpus rows, embeds their visual_description the way
// orchestrator.ts embeds an upload's description, and asks the live RPC for
// neighbours. Prints the description-space result beside the title-space
// result the pipeline used BEFORE 0003, so the difference is visible rather
// than asserted.
//
// Read it as a sanity check, not a metric: it confirms the vectors are in the
// right space and the RPC is wired up. Whether retrieval actually helps the
// generated titles is deliverable 4's job.

import { loadEnvLocal, requireEnv } from './lib/load-env';

const NICHE = 'luxury-menswear';
const PROBES = 3;
const TOP_N = 4;

type Row = {
  id: string;
  title: string;
  visual_description: string;
  creator_handle: string | null;
  embedding: string | number[];
  similarity?: number;
};

function sb() {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY!;
  return {
    url: process.env.SUPABASE_URL!,
    headers: {
      apikey: key,
      authorization: `Bearer ${key}`,
      'content-type': 'application/json',
    } as Record<string, string>,
  };
}

const vec = (e: string | number[]): number[] => (typeof e === 'string' ? JSON.parse(e) : e);

function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1);
}

const short = (s: string, n = 88) => (s.length > n ? `${s.slice(0, n)}…` : s);

async function main() {
  loadEnvLocal();
  requireEnv(['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'OPENAI_API_KEY']);
  const { url, headers } = sb();

  const all = (await fetch(
    `${url}/rest/v1/corpus_titles?niche_id=eq.${NICHE}&select=id,title,visual_description,creator_handle,embedding`,
    { headers },
  ).then((r) => r.json())) as Row[];
  console.log(`${all.length} corpus rows\n`);
  if (all.length === 0) throw new Error('corpus is empty — run npm run import:dataset -- --apply');

  const { embed } = await import('../lib/providers/openai/embedding');

  // Spread the probes across the corpus rather than taking the first few,
  // which are all one creator.
  const probes = Array.from({ length: PROBES }, (_, i) => all[Math.floor((i * all.length) / PROBES)]);

  for (const probe of probes) {
    // Same construction as orchestrator.ts: the stored visual_description IS
    // `scene + visualHook`, which is exactly what the app embeds at upload.
    const q = await embed(probe.visual_description);

    const rpc = (await fetch(`${url}/rest/v1/rpc/match_corpus_titles`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        p_niche_id: NICHE,
        p_query_embed: JSON.stringify(q.vector),
        p_match_limit: TOP_N + 1,
      }),
    }).then((r) => r.json())) as Row[];

    // What the pipeline did before 0003: compare the description vector
    // against the TITLE embedding.
    const titleSpace = all
      .filter((r) => r.id !== probe.id)
      .map((r) => ({ r, s: cosine(q.vector, vec(r.embedding)) }))
      .sort((a, b) => b.s - a.s)
      .slice(0, TOP_N);

    console.log('═'.repeat(100));
    console.log(`QUERY  [${probe.creator_handle}] ${probe.title}`);
    console.log(`       ${short(probe.visual_description, 150)}\n`);

    console.log('  description-space (0003, live RPC):');
    for (const r of rpc.filter((r) => r.id !== probe.id).slice(0, TOP_N)) {
      console.log(`    ${(r.similarity ?? 0).toFixed(3)}  ${short(r.title, 60).padEnd(62)} ${short(r.visual_description, 70)}`);
    }

    console.log('\n  title-space (what it did before):');
    for (const { r, s } of titleSpace) {
      console.log(`    ${s.toFixed(3)}  ${short(r.title, 60).padEnd(62)} ${short(r.visual_description, 70)}`);
    }

    const overlap = rpc.filter((a) => titleSpace.some((b) => b.r.id === a.id)).length;
    console.log(`\n  overlap between the two: ${overlap}/${TOP_N}\n`);
  }

  // A self-match must rank first. If it does not, the corpus and query vectors
  // are not in the same space and something is wired wrong.
  const selfProbe = probes[0];
  const selfQ = await embed(selfProbe.visual_description);
  const selfTop = (await fetch(`${url}/rest/v1/rpc/match_corpus_titles`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ p_niche_id: NICHE, p_query_embed: JSON.stringify(selfQ.vector), p_match_limit: 1 }),
  }).then((r) => r.json())) as Row[];

  const ok = selfTop[0]?.id === selfProbe.id;
  console.log('═'.repeat(100));
  console.log(
    ok
      ? `self-match sanity: PASS (a row's own description retrieves it first, similarity ${(selfTop[0].similarity ?? 0).toFixed(4)})`
      : `self-match sanity: FAIL — expected "${selfProbe.title}", got "${selfTop[0]?.title}". Query and corpus vectors are not in the same space.`,
  );
  if (!ok) process.exit(1);
}

main().catch((e) => {
  console.error(`\n${(e as Error).message}`);
  process.exit(1);
});
