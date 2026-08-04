// Refresh expired video URLs from SocialCrawl, and optionally download.
//
// WHY THIS EXISTS
//
// Instagram CDN links are signed with an `oe=` expiry. The URLs Apify wrote
// into the manifests lapsed on 2026-07-29 and now return 403, so the 161
// previously-excluded rows that the corrected view metrics would admit cannot
// be fetched from what is on disk.
//
// Apify is no longer in use. SocialCrawl's /instagram/post/stats — the same
// endpoint collect-shares-direct.ts already calls for share counts — returns
// `post.content.media_urls` alongside the engagement figures. Verified: the
// returned link downloads a valid 720x1280 h264 mp4, and the fresh expiry is
// roughly 36 hours out.
//
// Because one call carries BOTH the media URL and the engagement numbers,
// refreshing URLs also refreshes SocialCrawl metrics at no extra credit cost.
//
// EXPIRY IS THE REASON --download EXISTS. A refresh-now-download-later flow is
// fragile when the link dies within ~36h, so the download is offered in the
// same pass.
//
// Usage:
//   npx tsx scripts/refresh-media-urls.ts                        # dry run
//   npx tsx scripts/refresh-media-urls.ts --apply                # write URLs
//   npx tsx scripts/refresh-media-urls.ts --apply --download     # + fetch files
//   npx tsx scripts/refresh-media-urls.ts --apply --limit 3      # smoke test
//   npx tsx scripts/refresh-media-urls.ts --apply --status included --download

import fs from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import path from 'node:path';
import { loadEnvLocal, requireEnv } from './lib/load-env';
import { loadManifest, saveManifest, type ManifestEntry } from './lib/manifest';

const CREDITS_PER_CALL = 5;
const CREDIT_FLOOR = 100;
const MAX_DURATION_SEC = 60; // the app's own hard cap; no point fetching longer
const MIN_MULTIPLIER = 3; // the selection gate these rows must now clear

// henryjwade was scraped in top-bottom mode, so the outliers gate does not
// apply to him — his "new candidates" are mid-pack, not top performers.
// See docs/SESSION-HANDOFF.md OPEN ITEMS.
const SKIP_HANDLES = new Set(['henryjwade']);

type Target = { handle: string; shortcode: string; multiplier: number | null };

type Args = { apply: boolean; download: boolean; admit: boolean; limit: number; statuses: string[] };

function parseArgs(argv: string[]): Args {
  const a: Args = {
    apply: false,
    download: false,
    admit: false,
    limit: Infinity,
    statuses: ['excluded_low_views', 'excluded_rank'],
  };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t === '--apply') a.apply = true;
    else if (t === '--download') a.download = true;
    else if (t === '--admit') a.admit = true;
    else if (t === '--limit') a.limit = parseInt(argv[++i], 10);
    else if (t === '--status') a.statuses = argv[++i].split(',').map((s) => s.trim());
    else throw new Error(`unknown argument: ${t}`);
  }
  if (!Number.isFinite(a.limit) && a.limit !== Infinity) throw new Error('--limit requires a number');
  // Admitting a row without its file would put a status of 'scraped' on
  // something OCR cannot open — the stage selects on status AND videoPath.
  if (a.admit && !a.download) throw new Error('--admit requires --download: OCR needs the file, not just the URL');
  return a;
}

// Rows whose corrected metrics now clear the gate that their corrupt metrics
// failed. Deliberately NOT filtered on videoUrl being absent: every stored URL
// has expired, so a present-but-dead URL is exactly what we are replacing.
function isCandidate(e: ManifestEntry, statuses: string[]): boolean {
  if (!statuses.includes(e.status)) return false;
  if (statuses.includes('included')) return true; // explicit opt-in, no gate
  if (typeof e.outlierMultiplier !== 'number' || e.outlierMultiplier < MIN_MULTIPLIER) return false;
  if (e.durationSec !== null && e.durationSec > MAX_DURATION_SEC) return false;
  return true;
}

async function findTargets(rawRoot: string, statuses: string[]): Promise<Target[]> {
  const out: Target[] = [];
  const dirs = (await fs.readdir(rawRoot, { withFileTypes: true }))
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();
  for (const handle of dirs) {
    if (SKIP_HANDLES.has(handle)) continue;
    const entries = await loadManifest(path.join(rawRoot, handle));
    for (const e of entries) {
      if (!isCandidate(e, statuses)) continue;
      out.push({ handle, shortcode: e.shortcode, multiplier: e.outlierMultiplier ?? null });
    }
  }
  // Best candidates first, so a --limit or a credit floor keeps the strongest.
  return out.sort((a, b) => (b.multiplier ?? 0) - (a.multiplier ?? 0));
}

type Fetched = {
  mediaUrl: string;
  durationSec: number | null;
  expiresAt: string | null;
  stats: NonNullable<ManifestEntry['socialcrawl']>;
};

function expiryOf(url: string): string | null {
  const m = url.match(/oe=([0-9A-Fa-f]+)/);
  if (!m) return null;
  const secs = parseInt(m[1], 16);
  return Number.isFinite(secs) ? new Date(secs * 1000).toISOString() : null;
}

async function fetchOne(
  apiKey: string,
  shortcode: string,
): Promise<{ got: Fetched | null; credits: number | null; err?: string }> {
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
        if (res.status === 404 || res.status === 400) break; // will not fix itself
      } else {
        const data = body.data as {
          post?: {
            content?: { media_urls?: unknown; duration_seconds?: number | null };
            engagement?: Record<string, number | null>;
          };
          computed?: Record<string, number>;
        };
        const raw = data.post?.content?.media_urls;
        // Observed as a string; tolerate an array in case the shape varies.
        const mediaUrl = Array.isArray(raw) ? (raw[0] as string | undefined) : (raw as string | undefined);
        if (!mediaUrl) {
          lastErr = 'response carried no media_urls';
          break;
        }
        const eng = data.post?.engagement ?? {};
        // credits_remaining reads 0 on cached responses (SocialCrawl bug), so
        // it is only meaningful when the response was not served from cache.
        const credits = body.cached === false ? (body.credits_remaining as number) : null;
        return {
          got: {
            mediaUrl,
            durationSec: data.post?.content?.duration_seconds ?? null,
            expiresAt: expiryOf(mediaUrl),
            stats: {
              views: eng.views ?? null,
              likes: eng.likes ?? null,
              comments: eng.comments ?? null,
              shares: eng.shares ?? null,
              engagementRate: data.computed?.engagement_rate ?? null,
              estimatedReach: data.computed?.estimated_reach ?? null,
              fetchedAt: new Date().toISOString(),
            },
          },
          credits,
        };
      }
    } catch (e) {
      lastErr = (e as Error).message;
    }
    if (attempt < 3) await new Promise((r) => setTimeout(r, attempt * 3000));
  }
  return { got: null, credits: null, err: lastErr };
}

async function downloadTo(url: string, destPath: string): Promise<number> {
  const res = await fetch(url);
  if (!res.ok || !res.body) throw new Error(`download failed: ${res.status}`);
  await fs.mkdir(path.dirname(destPath), { recursive: true });
  // Stream to a temp file, then rename, so an interrupted fetch cannot leave a
  // truncated .mp4 that later stages would treat as valid.
  const tmp = `${destPath}.part`;
  await pipeline(Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0]), createWriteStream(tmp));
  await fs.rename(tmp, destPath);
  return (await fs.stat(destPath)).size;
}

async function main() {
  loadEnvLocal();
  requireEnv(['SOCIALCRAWL_API_KEY']);
  const apiKey = process.env.SOCIALCRAWL_API_KEY!;
  const args = parseArgs(process.argv.slice(2));
  const rawRoot = path.join(process.cwd(), 'datasets', 'raw');

  const all = await findTargets(rawRoot, args.statuses);
  const targets = Number.isFinite(args.limit) ? all.slice(0, args.limit) : all;

  const byHandle = new Map<string, number>();
  for (const t of all) byHandle.set(t.handle, (byHandle.get(t.handle) ?? 0) + 1);

  console.log(`status filter: ${args.statuses.join(', ')}`);
  console.log(`${all.length} candidate rows (excluding ${[...SKIP_HANDLES].join(', ')}):`);
  for (const [h, n] of [...byHandle.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${h.padEnd(18)}${n}`);
  }
  console.log(
    `\nprocessing ${targets.length} — up to ${targets.length * CREDITS_PER_CALL} credits — ` +
      `mode: ${args.apply ? 'APPLY' : 'DRY RUN'}${args.download ? ' + DOWNLOAD' : ''}${args.admit ? ' + ADMIT' : ''}\n`,
  );
  if (!args.apply) {
    console.log('dry run: nothing written. Re-run with --apply (add --download to fetch files).');
    console.log('NOTE: refreshed URLs expire in roughly 36 hours — download promptly.');
    return;
  }

  const grouped = new Map<string, Target[]>();
  for (const t of targets) {
    if (!grouped.has(t.handle)) grouped.set(t.handle, []);
    grouped.get(t.handle)!.push(t);
  }

  let ok = 0;
  let downloaded = 0;
  let admitted = 0;
  let failed = 0;
  let bytes = 0;
  let lastCredits: number | null = null;
  let earliestExpiry: string | null = null;
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
        console.log(`\ndone. urls ${ok}, downloaded ${downloaded}, admitted ${admitted}, failed ${failed}.`);
        return;
      }

      const { got, credits, err } = await fetchOne(apiKey, t.shortcode);
      if (credits !== null) lastCredits = credits;
      const entry = index.get(t.shortcode);
      if (!got || !entry) {
        failed++;
        const why = !entry ? 'not found in manifest' : (err ?? 'unknown');
        failures.push(`${handle}/${t.shortcode}: ${why}`);
        console.log(`  ${handle}/${t.shortcode}: FAILED — ${why}`);
        continue;
      }

      entry.videoUrl = got.mediaUrl;
      // SocialCrawl's duration is authoritative here: the app enforces a 60s
      // cap and the stored value came from a source no longer in use.
      if (got.durationSec !== null) entry.durationSec = got.durationSec;
      entry.socialcrawl = got.stats; // free — same call
      touched++;
      ok++;
      if (got.expiresAt && (!earliestExpiry || got.expiresAt < earliestExpiry)) {
        earliestExpiry = got.expiresAt;
      }

      let note = '';
      if (args.download) {
        const rel = path.join('videos', `${t.shortcode}.mp4`);
        try {
          const size = await downloadTo(got.mediaUrl, path.join(dir, rel));
          entry.videoPath = rel;
          downloaded++;
          bytes += size;
          note = ` downloaded ${(size / 1024 / 1024).toFixed(1)}MB`;
          if (args.admit) {
            // 'scraped' is the status extract-burned-in-titles.ts selects on.
            // Recorded, not silent: these rows were excluded on the corrupt
            // view numbers, and a reader should be able to tell them apart
            // from rows that cleared the gate first time.
            entry.readmittedFrom = entry.status;
            entry.status = 'scraped';
            admitted++;
            note += ' + admitted';
          }
        } catch (e) {
          failed++;
          failures.push(`${handle}/${t.shortcode}: ${(e as Error).message}`);
          note = ` DOWNLOAD FAILED — ${(e as Error).message}`;
        }
      }
      console.log(
        `  ${handle}/${t.shortcode}: url ok, ${got.durationSec?.toFixed(1) ?? '?'}s${note} (credits ${lastCredits ?? '?'})`,
      );
    }

    if (touched > 0) await saveManifest(dir, manifest);
  }

  console.log(
    `\ndone. urls ${ok}, downloaded ${downloaded} (${(bytes / 1024 / 1024).toFixed(1)}MB), ` +
      `admitted ${admitted}, failed ${failed}.`,
  );
  console.log(`credits remaining ${lastCredits ?? '?'}`);
  if (earliestExpiry) {
    console.log(`earliest URL expiry: ${earliestExpiry}`);
    if (!args.download) console.log('Not downloaded — fetch before that time or the URLs must be refreshed again.');
  }
  if (failures.length) {
    console.log('\nfailures:');
    failures.forEach((f) => console.log('  ' + f));
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
