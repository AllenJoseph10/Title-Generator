// Human-readable dump of every vote, for admin review.
//
// Run: npm run review:feedback
// Writes: datasets/raw/_title-feedback.md (gitignored, like the rest of raw/)

import fs from 'node:fs';
import path from 'node:path';
import { loadEnvLocal, requireEnv } from './lib/load-env';
import { renderFeedbackReport, type FeedbackRow } from './lib/feedback-report';

const OUT = path.join('datasets', 'raw', '_title-feedback.md');

async function main() {
  loadEnvLocal();
  requireEnv(['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY']);
  const url = process.env.SUPABASE_URL!;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY!;

  const select =
    'vote,title_index,created_at,generation_id,' +
    'generations(vision_description,generated_titles,generation_attempts(creator_handle))';
  const res = await fetch(
    `${url}/rest/v1/title_feedback?select=${encodeURIComponent(select)}&order=created_at.desc`,
    { headers: { apikey: key, authorization: `Bearer ${key}` } },
  );
  if (!res.ok) throw new Error(`title_feedback: ${res.status} ${await res.text()}`);

  const raw = (await res.json()) as any[];
  const rows: FeedbackRow[] = raw.flatMap((r) => {
    const gen = r.generations;
    const picked = gen?.generated_titles?.[r.title_index];
    const vision = gen?.vision_description;
    const handle = gen?.generation_attempts?.creator_handle;
    if (!picked || !vision) return [];
    return [{
      creatorHandle: handle ?? '(unattributed)',
      vote: r.vote as 1 | -1,
      title: picked.text,
      hookFamily: picked.hookFamily ?? '(unknown)',
      visualDescription: `${vision.scene} ${vision.visualHook}`,
      generationId: r.generation_id,
      createdAt: r.created_at,
    }];
  });

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, renderFeedbackReport(rows, new Date().toISOString()), 'utf8');
  console.log(`wrote ${rows.length} votes to ${OUT}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
