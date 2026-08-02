// Fill in missing SocialCrawl share counts by direct per-post lookup.
//
// Why this exists alongside scripts/collect-shares.ts: the bulk
// /profile/reels/full endpoint performs an internal per-reel "shares fanout"
// (visible as shares_fanout_calls in its response), so a single page of 10
// takes ~17s. Our remaining target rows sit deep in each creator's profile,
// so reaching them by paging costs many slow pages and reliably 504s.
//
// /instagram/post/stats takes a URL and returns one post's stats for a flat
// 5 credits. Slower per row in credits, but it cannot silently match nothing
// and cannot time out from fanout paging.
//
// Usage:
//   npx tsx scripts/collect-shares-direct.ts            # dry run, lists targets
//   npx tsx scripts/collect-shares-direct.ts --apply    # writes
//   npx tsx scripts/collect-shares-direct.ts --apply --limit 2   # verify first

import fs from 'node:fs/promises';
import path from 'node:path';
import { loadEnvLocal, requireEnv } from './lib/load-env';
import { loadManifest, saveManifest, type ManifestEntry } from './lib/manifest';

const CREDITS_PER_CALL = 5;
const CREDIT_FLOOR = 100;

type Target = { handle: string; shortcode: string; permalink: string; views: number | null };

function parseArgs(argv: string[]) {
  let apply = false;
  let limit = Infinity;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--apply') apply = true;
    else if (argv[i] === '--limit') limit = parseInt(argv[++i], 10);
  }
  return { apply, limit };
}

async function findTargets(rawRoot: string): Promise<Target[]> {
  const out: Target[] = [];
  const dirs = (await fs.readdir(rawRoot, { withFileTypes: true }))
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();
  for (const handle of dirs) {
    const entries = await loadManifest(path.join(rawRoot, handle));
    for (const e of entries) {
      if (e.status !== 'included') continue;
      const sc = e.socialcrawl as { shares?: unknown } | undefined;
      if (sc && typeof sc.shares === 'number') continue; // already have it
      out.push({ handle, shortcode: e.shortcode, permalink: e.permalink, views: e.views });
    }
  }
  return out;
}

type Stats = {
  views: number | null;
  likes: number | null;
  comments: number | null;
  shares: number | null;
  engagementRate: number | null;
  estimatedReach: number | null;
  fetchedAt: string;
};

async function fetchOne(apiKey: string, shortcode: string): Promise<{ stats: Stats | null; credits: number | null; err?: string }> {
  const url =
    'https://www.socialcrawl.dev/v1/instagram/post/stats?url=' +
    encodeURIComponent(`https://www.instagram.com/p/${shortcode}/`);
  let lastErr = '';
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(url, { headers: { 'x-api-key': apiKey } });
      const body = (await res.json()) as Record<string, unknown>;
      if (!res.ok || body.success !== true) {
        const e = body.error as { type?: string; message?: string } | undefined;
        lastErr = `${res.status} ${e?.type ?? ''} ${e?.message ?? ''}`.trim();
        // A genuine 404/400 will not fix itself on retry.
        if (res.status === 404 || res.status === 400) break;
      } else {
        const data = body.data as { post?: { engagement?: Record<string, number | null> }; computed?: Record<string, number> };
        const eng = data.post?.engagement ?? {};
        // credits_remaining is 0 on cached responses (SocialCrawl bug) — only
        // trust it when the response was not served from cache.
        const credits = body.cached === false ? (body.credits_remaining as number) : null;
        return {
          stats: {
            views: eng.views ?? null,
            likes: eng.likes ?? null,
            comments: eng.comments ?? null,
            shares: eng.shares ?? null,
            engagementRate: data.computed?.engagement_rate ?? null,
            estimatedReach: data.computed?.estimated_reach ?? null,
            fetchedAt: new Date().toISOString(),
          },
          credits,
        };
      }
    } catch (e) {
      lastErr = (e as Error).message;
    }
    if (attempt < 3) await new Promise((r) => setTimeout(r, attempt * 3000));
  }
  return { stats: null, credits: null, err: lastErr };
}

async function main() {
  loadEnvLocal();
  requireEnv(['SOCIALCRAWL_API_KEY']);
  const apiKey = process.env.SOCIALCRAWL_API_KEY!;
  const { apply, limit } = parseArgs(process.argv.slice(2));
  const rawRoot = path.join(process.cwd(), 'datasets', 'raw');

  const all = await findTargets(rawRoot);
  const targets = all.slice(0, Number.isFinite(limit) ? limit : undefined);

  const byHandle = new Map<string, number>();
  for (const t of all) byHandle.set(t.handle, (byHandle.get(t.handle) ?? 0) + 1);

  console.log(`${all.length} included rows still missing a share count:`);
  for (const [h, n] of [...byHandle.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${h.padEnd(18)}${n}`);
  }
  console.log(`\nprocessing ${targets.length} (${targets.length * CREDITS_PER_CALL} credits max) — mode: ${apply ? 'APPLY' : 'DRY RUN'}\n`);
  if (!apply) {
    console.log('dry run: nothing written. Re-run with --apply.');
    return;
  }

  // Group by handle so each manifest is loaded and saved once.
  const grouped = new Map<string, Target[]>();
  for (const t of targets) {
    if (!grouped.has(t.handle)) grouped.set(t.handle, []);
    grouped.get(t.handle)!.push(t);
  }

  let ok = 0;
  let failed = 0;
  let lastCredits: number | null = null;
  const failures: string[] = [];

  for (const [handle, rows] of grouped) {
    const dir = path.join(rawRoot, handle);
    const manifest = await loadManifest(dir);
    const index = new Map<string, ManifestEntry>(manifest.map((e) => [e.shortcode, e]));
    let touched = 0;

    for (const t of rows) {
      if (lastCredits !== null && lastCredits < CREDIT_FLOOR) {
        console.log(`\nSTOPPING: credit floor reached (${lastCredits} remaining).`);
        if (touched > 0) await saveManifest(dir, manifest);
        console.log(`\ndone. filled ${ok}, failed ${failed}. credits remaining ${lastCredits ?? '?'}`);
        return;
      }
      const { stats, credits, err } = await fetchOne(apiKey, t.shortcode);
      if (credits !== null) lastCredits = credits;
      if (!stats) {
        failed++;
        failures.push(`${handle}/${t.shortcode}: ${err ?? 'unknown'}`);
        console.log(`  ${handle}/${t.shortcode}: FAILED — ${err ?? 'unknown'}`);
        continue;
      }
      const entry = index.get(t.shortcode);
      if (!entry) {
        failed++;
        failures.push(`${handle}/${t.shortcode}: not found in manifest`);
        continue;
      }
      entry.socialcrawl = stats;
      touched++;
      ok++;
      console.log(
        `  ${handle}/${t.shortcode}: shares=${stats.shares ?? 'null'} views=${stats.views ?? '?'} (credits ${lastCredits ?? '?'})`,
      );
    }

    if (touched > 0) await saveManifest(dir, manifest);
  }

  console.log(`\ndone. filled ${ok}, failed ${failed}. credits remaining ${lastCredits ?? '?'}`);
  if (failures.length) {
    console.log('\nfailures:');
    failures.forEach((f) => console.log('  ' + f));
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
