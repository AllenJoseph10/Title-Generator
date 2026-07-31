// Stage 1 — scrape post metadata + download qualifying videos for one creator.
// Usage:
//   tsx scripts/scrape-instagram.ts <handle> --mode top-bottom [--limit N] [--fetch N] [--max-duration-sec N] [--newer-than "12 months"]
//   tsx scripts/scrape-instagram.ts <handle> --mode outliers   [--limit N] [--fetch N] [--outlier-multiplier N] [--min-views N] [--max-duration-sec N] [--newer-than "9 months"]
//
// Two selection modes, because "the subject's own corpus" and "borrowed B-roll
// patterns" need different logic:
//
// --mode top-bottom (for the subject creator, e.g. Henry/William himself): no
// outlier filter at all. Sorts every candidate in the window by views and takes
// the top N (his best) and bottom N (his flops) — --limit N means N per side,
// 2N videos total. The corpus needs his full performance range, including what
// DIDN'T work, so an outlier-only filter would systematically discard every flop.
//
// --mode outliers (for B-roll/adjacent creators): a post qualifies when its
// views are >= --outlier-multiplier times the creator's own "expected views"
// baseline (median views across the fetched window, with the creator's own
// existing extreme outliers excluded from that baseline calc first, so one
// freak hit doesn't skew what counts as normal for them). --min-views remains
// available as an optional secondary absolute floor (default 0 = disabled) for
// cross-creator consistency. Ranks qualifying posts by views-per-day-since-
// posted rather than raw views — an old post that slowly compounded to a big
// number is weaker evidence of current relevance than a young post climbing
// fast to the same number.
//
// Writes datasets/raw/<handle>/manifest.json (full audit trail — every post
// evaluated and why it was kept/excluded) and datasets/raw/<handle>/videos/*.mp4.
// Re-running is safe: already-downloaded videos are skipped, and posts already
// past Stage 2 (OCR'd) are never reset back to an earlier status.

import fs from 'node:fs/promises';
import path from 'node:path';
import { loadEnvLocal, requireEnv } from './lib/load-env';

const ACTOR_ID = 'apify~instagram-reel-scraper';
const DEFAULT_MAX_DURATION_SEC = 60;
const DEFAULT_OUTLIER_MULTIPLIER = 3;
// 3 months: a wider window risks pulling in stale algorithmic/trend patterns
// and computing the "expected views" baseline against posts that no longer
// reflect current audience behavior.
const DEFAULT_NEWER_THAN_OUTLIERS = '3 months';
// The subject's own corpus slice follows the brief's literal 12-month window.
const DEFAULT_NEWER_THAN_TOP_BOTTOM = '12 months';
const DEFAULT_LIMIT_OUTLIERS = 10;
const DEFAULT_LIMIT_TOP_BOTTOM = 50;
const STAGE2_STATUSES = new Set(['included', 'excluded_no_title', 'excluded_multi_title']);

type Mode = 'outliers' | 'top-bottom';

type CliArgs = {
  handle: string;
  mode: Mode;
  limit: number;
  fetch: number;
  minViews: number;
  outlierMultiplier: number;
  maxDurationSec: number;
  newerThan: string;
};

function parseArgs(argv: string[]): CliArgs {
  const [handle, ...rest] = argv;
  if (!handle) {
    console.error(
      'Usage: scrape-instagram <handle> --mode <top-bottom|outliers> [--limit N] [--fetch N] [--outlier-multiplier N] [--min-views N] [--max-duration-sec N] [--newer-than "3 months"]',
    );
    process.exit(1);
  }
  let mode: Mode = 'outliers';
  let newerThan: string | undefined;
  let limit: number | undefined;
  const opts = {
    handle,
    fetch: 50,
    minViews: 0,
    outlierMultiplier: DEFAULT_OUTLIER_MULTIPLIER,
    maxDurationSec: DEFAULT_MAX_DURATION_SEC,
  };
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    const next = () => rest[++i];
    if (a === '--mode') {
      const m = next();
      if (m !== 'outliers' && m !== 'top-bottom') throw new Error(`--mode must be "outliers" or "top-bottom" (got "${m}")`);
      mode = m;
    } else if (a === '--limit') limit = parseInt(next(), 10);
    else if (a === '--fetch') opts.fetch = parseInt(next(), 10);
    else if (a === '--min-views') opts.minViews = parseInt(next(), 10);
    else if (a === '--outlier-multiplier') opts.outlierMultiplier = parseFloat(next());
    else if (a === '--max-duration-sec') opts.maxDurationSec = parseInt(next(), 10);
    else if (a === '--newer-than') newerThan = next();
  }
  return {
    ...opts,
    mode,
    limit: limit ?? (mode === 'top-bottom' ? DEFAULT_LIMIT_TOP_BOTTOM : DEFAULT_LIMIT_OUTLIERS),
    newerThan: newerThan ?? (mode === 'top-bottom' ? DEFAULT_NEWER_THAN_TOP_BOTTOM : DEFAULT_NEWER_THAN_OUTLIERS),
  };
}

// Parses the small set of relative-date strings this script actually uses
// ("N months"/"weeks"/"days"/"years") into a cutoff Date, for retroactively
// re-checking previously-selected posts against a NEW (e.g. narrower) window.
// Falls back to parsing as an absolute date; returns null if neither works.
function parseNewerThanCutoff(newerThan: string): Date | null {
  const match = newerThan.match(/^(\d+)\s+(day|week|month|year)s?$/i);
  if (match) {
    const n = parseInt(match[1], 10);
    const unit = match[2].toLowerCase();
    const cutoff = new Date();
    if (unit === 'day') cutoff.setDate(cutoff.getDate() - n);
    else if (unit === 'week') cutoff.setDate(cutoff.getDate() - n * 7);
    else if (unit === 'month') cutoff.setMonth(cutoff.getMonth() - n);
    else if (unit === 'year') cutoff.setFullYear(cutoff.getFullYear() - n);
    return cutoff;
  }
  const asDate = new Date(newerThan);
  return Number.isNaN(asDate.getTime()) ? null : asDate;
}

function median(nums: number[]): number {
  if (nums.length === 0) return 0;
  const sorted = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

// "Expected views" baseline for this creator: median views, computed after
// excluding their own existing extreme outliers (>5x or <0.2x the raw median)
// so a prior freak hit doesn't inflate what counts as "normal" for them.
function expectedViewsBaseline(allViews: number[]): number {
  const raw = median(allViews);
  if (raw === 0) return 0;
  const cleaned = allViews.filter((v) => v <= raw * 5 && v >= raw * 0.2);
  return median(cleaned.length > 0 ? cleaned : allViews);
}

function ageDaysSince(postedAt: string | null): number | null {
  if (!postedAt) return null;
  const posted = new Date(postedAt).getTime();
  if (Number.isNaN(posted)) return null;
  return Math.max(1, Math.round((Date.now() - posted) / 86_400_000));
}

type RawItem = Record<string, unknown>;

function pick(item: RawItem, keys: string[]): unknown {
  for (const k of keys) {
    if (item[k] !== undefined && item[k] !== null) return item[k];
  }
  return undefined;
}

function toNumber(v: unknown): number | null {
  if (typeof v === 'number') return v;
  if (typeof v === 'string' && v.trim() !== '') return Number(v);
  return null;
}

function normalizeTimestamp(v: unknown): string | null {
  if (v === undefined || v === null) return null;
  if (typeof v === 'number') {
    const ms = v > 1e12 ? v : v * 1000;
    return new Date(ms).toISOString().slice(0, 10);
  }
  if (typeof v === 'string') {
    const d = new Date(v);
    if (!Number.isNaN(d.getTime())) return d.toISOString().slice(0, 10);
  }
  return null;
}

type NormalizedPost = {
  shortcode: string;
  permalink: string;
  caption: string;
  views: number | null;
  likes: number | null;
  comments: number | null;
  postedAt: string | null;
  durationSec: number | null;
  videoUrl: string | null;
};

function normalize(item: RawItem): NormalizedPost | null {
  const shortcode = pick(item, ['shortCode', 'shortcode', 'code']) as string | undefined;
  const videoUrl = pick(item, ['videoUrl', 'videoUrlFull', 'video_url']) as string | undefined;
  if (!shortcode || !videoUrl) return null;
  return {
    shortcode,
    permalink: (pick(item, ['url', 'postUrl', 'link']) as string) ?? `https://www.instagram.com/reel/${shortcode}/`,
    caption: (pick(item, ['caption', 'text']) as string) ?? '',
    views: toNumber(pick(item, ['videoViewCount', 'videoPlayCount', 'playsCount', 'viewCount'])),
    likes: toNumber(pick(item, ['likesCount', 'likeCount'])),
    comments: toNumber(pick(item, ['commentsCount', 'commentCount'])),
    postedAt: normalizeTimestamp(pick(item, ['timestamp', 'takenAt', 'takenAtTimestamp', 'postedAt'])),
    durationSec: toNumber(pick(item, ['videoDuration', 'duration'])),
    videoUrl,
  };
}

async function runApifyActor(handle: string, resultsLimit: number, newerThan?: string): Promise<RawItem[]> {
  const url = `https://api.apify.com/v2/acts/${ACTOR_ID}/run-sync-get-dataset-items?token=${process.env.APIFY_API_TOKEN}`;
  const input: Record<string, unknown> = { username: [handle], resultsLimit };
  if (newerThan) input.onlyPostsNewerThan = newerThan;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  });
  if (!res.ok) {
    throw new Error(`Apify actor call failed: ${res.status} ${await res.text()}`);
  }
  return (await res.json()) as RawItem[];
}

async function downloadVideo(url: string, destPath: string): Promise<void> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`download failed: ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  await fs.writeFile(destPath, buf);
}

type ManifestEntry = NormalizedPost & {
  status: string;
  videoPath?: string;
  burnedInTitle?: string;
  additionalTitles?: string[];
  ocrCostUsd?: number;
  outlierMultiplier?: number;
  viewsPerDay?: number;
  rank?: 'top' | 'bottom'; // set in --mode top-bottom; useful later for the eval harness
  duplicateOfHandle?: string; // set when excluded_duplicate — which creator already has this post
};

async function loadManifest(dir: string): Promise<ManifestEntry[]> {
  try {
    const text = await fs.readFile(path.join(dir, 'manifest.json'), 'utf8');
    return JSON.parse(text) as ManifestEntry[];
  } catch {
    return [];
  }
}

async function saveManifest(dir: string, entries: ManifestEntry[]): Promise<void> {
  await fs.writeFile(path.join(dir, 'manifest.json'), JSON.stringify(entries, null, 2));
}

// Instagram shortcodes are unique per post. A shortcode already selected under
// a DIFFERENT creator's manifest means that creator's profile reshared someone
// else's post (a curation/repost account) rather than posting original content
// — real case: tobiasrtr's "reels" turned out to include reposts of Henry's own
// videos. Scans every other creator's manifest.json and returns shortcode ->
// handle for anything already kept (selected, not excluded for another reason).
const SELECTED_STATUSES = new Set(['scraped', 'included', 'excluded_no_title', 'excluded_multi_title']);

async function loadCrossCreatorShortcodes(rawRoot: string, excludeHandle: string): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  let handles: string[];
  try {
    handles = await fs.readdir(rawRoot);
  } catch {
    return result;
  }
  for (const handle of handles) {
    if (handle === excludeHandle) continue;
    let entries: ManifestEntry[];
    try {
      entries = JSON.parse(await fs.readFile(path.join(rawRoot, handle, 'manifest.json'), 'utf8'));
    } catch {
      continue;
    }
    for (const e of entries) {
      if (!SELECTED_STATUSES.has(e.status)) continue;
      if (!result.has(e.shortcode)) result.set(e.shortcode, handle);
    }
  }
  return result;
}

async function main() {
  loadEnvLocal();
  requireEnv(['APIFY_API_TOKEN']);

  const args = parseArgs(process.argv.slice(2));
  const dir = path.join(process.cwd(), 'datasets', 'raw', args.handle);
  const videosDir = path.join(dir, 'videos');
  await fs.mkdir(videosDir, { recursive: true });

  console.log(`Scraping @${args.handle} — requesting up to ${args.fetch} recent reels from Apify (${ACTOR_ID})...`);
  const raw = await runApifyActor(args.handle, args.fetch, args.newerThan);
  console.log(`Apify returned ${raw.length} raw items.`);

  if (raw.length > 0) {
    await fs.writeFile(path.join(dir, '_debug_raw_sample.json'), JSON.stringify(raw.slice(0, 2), null, 2));
  }

  const manifest = await loadManifest(dir);
  const byShortcode = new Map(manifest.map((e) => [e.shortcode, e]));

  // Retroactively re-check previously-SELECTED (not yet OCR'd) posts against
  // the current --newer-than window. A narrower window on a later run means
  // Apify simply won't return those older posts again, so without this check
  // they'd silently stay marked "scraped" forever even though they no longer
  // belong in the corpus under the corrected window.
  const cutoff = parseNewerThanCutoff(args.newerThan);
  let excludedByWindow = 0;
  if (cutoff) {
    for (const [sc, entry] of byShortcode) {
      if (entry.status === 'scraped' && entry.postedAt && new Date(entry.postedAt) < cutoff) {
        byShortcode.set(sc, { ...entry, status: 'excluded_window' });
        excludedByWindow++;
      }
    }
  }
  if (excludedByWindow > 0) {
    console.log(`Re-excluded ${excludedByWindow} previously-selected post(s) now outside the ${args.newerThan} window.`);
  }

  const rawRoot = path.join(process.cwd(), 'datasets', 'raw');
  const crossCreatorShortcodes = await loadCrossCreatorShortcodes(rawRoot, args.handle);

  // Pass 1: normalize + hard gates (duration cap, cross-creator duplicates,
  // already-OCR'd entries untouched).
  const candidates: NormalizedPost[] = [];
  let skippedNoVideo = 0;
  let skippedDuplicate = 0;
  for (const item of raw) {
    const post = normalize(item);
    if (!post) {
      skippedNoVideo++;
      continue;
    }
    const existing = byShortcode.get(post.shortcode);
    if (existing && STAGE2_STATUSES.has(existing.status)) continue; // already OCR'd, don't reset

    if (post.durationSec !== null && post.durationSec > args.maxDurationSec) {
      byShortcode.set(post.shortcode, { ...post, status: 'excluded_duration' });
      continue;
    }
    // Hard local date gate — do not rely on Apify's onlyPostsNewerThan alone.
    // Confirmed in practice: it does not reliably keep older posts out of the
    // response (a real post from 6 months back came back through a "3 months"
    // request and got re-selected purely on view count).
    if (cutoff && post.postedAt && new Date(post.postedAt) < cutoff) {
      byShortcode.set(post.shortcode, { ...post, status: 'excluded_window' });
      continue;
    }
    const duplicateOfHandle = crossCreatorShortcodes.get(post.shortcode);
    if (duplicateOfHandle) {
      byShortcode.set(post.shortcode, { ...post, status: 'excluded_duplicate', duplicateOfHandle });
      skippedDuplicate++;
      continue;
    }
    candidates.push(post);
  }
  if (skippedDuplicate > 0) {
    console.log(`Skipped ${skippedDuplicate} post(s) already claimed by another creator (repost/curation content).`);
  }

  // Merge in previously-evaluated candidates NOT present in this run's fresh
  // raw response. Apify's "most recent N" is not perfectly stable between
  // calls — a post can silently drop out of one fetch and reappear in the
  // next. Without this, ranking/capping only ever considers whatever THIS
  // fetch happened to contain, so a previously-scraped post can keep a stale
  // rank (including a cap slot it no longer deserves) indefinitely just
  // because it wasn't re-fetched this time.
  const candidateShortcodes = new Set(candidates.map((c) => c.shortcode));
  const RECONSIDER_STATUSES = new Set(['scraped', 'excluded_low_views', 'excluded_rank']);
  let mergedBack = 0;
  for (const entry of byShortcode.values()) {
    if (candidateShortcodes.has(entry.shortcode)) continue;
    if (!RECONSIDER_STATUSES.has(entry.status)) continue;
    if (entry.durationSec !== null && entry.durationSec > args.maxDurationSec) continue;
    if (cutoff && entry.postedAt && new Date(entry.postedAt) < cutoff) continue;
    candidates.push({
      shortcode: entry.shortcode,
      permalink: entry.permalink,
      caption: entry.caption,
      views: entry.views,
      likes: entry.likes,
      comments: entry.comments,
      postedAt: entry.postedAt,
      durationSec: entry.durationSec,
      videoUrl: entry.videoUrl,
    });
    candidateShortcodes.add(entry.shortcode);
    mergedBack++;
  }
  if (mergedBack > 0) {
    console.log(`Merged in ${mergedBack} previously-evaluated candidate(s) not present in this run's fresh fetch, for re-ranking.`);
  }

  type Selected = NormalizedPost & { outlierMultiplier?: number; viewsPerDay?: number; rank?: 'top' | 'bottom' };
  let qualifying: Selected[];

  if (args.mode === 'top-bottom') {
    // No outlier filter — the corpus needs the subject's full performance
    // range, including flops, or the model never learns what doesn't work.
    const byViews = [...candidates].sort((a, b) => (b.views ?? 0) - (a.views ?? 0));
    const top = byViews.slice(0, args.limit).map((p) => ({ ...p, rank: 'top' as const }));
    const bottomPool = byViews.slice(args.limit); // no overlap with `top`
    const bottom = bottomPool.slice(-args.limit).map((p) => ({ ...p, rank: 'bottom' as const }));
    qualifying = [...top, ...bottom];

    console.log(
      `${top.length} top + ${bottom.length} bottom (of ${candidates.length} candidates, <= ${args.maxDurationSec}s, within ${args.newerThan}). ${skippedNoVideo} skipped (no video/shortcode found in raw item).`,
    );
    for (const p of top) console.log(`  TOP    ${p.shortcode}: ${(p.views ?? 0).toLocaleString()} views`);
    for (const p of bottom) console.log(`  BOTTOM ${p.shortcode}: ${(p.views ?? 0).toLocaleString()} views`);
  } else {
    const baseline = expectedViewsBaseline(candidates.map((p) => p.views ?? 0).filter((v) => v > 0));
    console.log(
      `Baseline (expected) views for @${args.handle}: ${Math.round(baseline).toLocaleString()} (median of ${candidates.length} candidates, own extreme outliers excluded from the baseline calc)`,
    );

    // Relative-outlier gate (+ optional absolute floor), then rank by
    // views/day-since-posted rather than raw views.
    const scored: Selected[] = [];
    for (const post of candidates) {
      const views = post.views ?? 0;
      const multiplier = baseline > 0 ? views / baseline : 0;
      if (multiplier < args.outlierMultiplier || (args.minViews > 0 && views < args.minViews)) {
        byShortcode.set(post.shortcode, { ...post, status: 'excluded_low_views', outlierMultiplier: multiplier });
        continue;
      }
      const days = ageDaysSince(post.postedAt) ?? 9999;
      scored.push({ ...post, outlierMultiplier: multiplier, viewsPerDay: views / days });
    }

    scored.sort((a, b) => (b.viewsPerDay ?? 0) - (a.viewsPerDay ?? 0));
    qualifying = scored.slice(0, args.limit);

    // Explicitly exclude anything that cleared the baseline but missed the cap
    // — otherwise a post ranked 11th on a rerun with a smaller --limit would
    // silently keep whatever status it had from a previous, larger-cap run.
    for (const p of scored.slice(args.limit)) {
      byShortcode.set(p.shortcode, { ...p, status: 'excluded_rank' });
    }

    console.log(
      `${qualifying.length} posts qualify (>= ${args.outlierMultiplier}x baseline${
        args.minViews > 0 ? ` and >= ${args.minViews} views` : ''
      }, <= ${args.maxDurationSec}s, within ${args.newerThan}), ranked by views/day. ${skippedNoVideo} skipped (no video/shortcode found in raw item).`,
    );
    for (const p of qualifying) {
      console.log(
        `  ${p.shortcode}: ${(p.views ?? 0).toLocaleString()} views, ${(p.outlierMultiplier ?? 0).toFixed(1)}x baseline, ~${Math.round(p.viewsPerDay ?? 0).toLocaleString()}/day`,
      );
    }
  }

  let downloaded = 0;
  for (const post of qualifying) {
    const videoPath = path.join('videos', `${post.shortcode}.mp4`);
    const fullPath = path.join(dir, videoPath);
    const exists = await fs
      .access(fullPath)
      .then(() => true)
      .catch(() => false);
    if (!exists) {
      try {
        await downloadVideo(post.videoUrl!, fullPath);
        downloaded++;
      } catch (e) {
        console.error(`  download failed for ${post.shortcode}: ${(e as Error).message}`);
        byShortcode.set(post.shortcode, { ...post, status: 'excluded_no_video' });
        continue;
      }
    }
    byShortcode.set(post.shortcode, { ...post, status: 'scraped', videoPath });
  }

  await saveManifest(dir, Array.from(byShortcode.values()));
  console.log(`Downloaded ${downloaded} new videos. Manifest: ${dir}/manifest.json (${byShortcode.size} total entries tracked).`);
  console.log(`Real dollar cost of this Apify run is visible in Apify Console → Usage.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
