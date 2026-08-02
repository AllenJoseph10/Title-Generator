// Stage 1 repair — re-pulls views/likes/comments for EXISTING manifest rows
// from Apify, matched by shortcode, now that scripts/scrape-instagram.ts:195
// has been fixed to prefer `videoPlayCount` over `videoViewCount` (the two
// disagree by 2.6x-130x on the same video; ~88% of stored views were 2-3x too
// low). See docs/findings/2026-08-02-view-metric-inconsistency.md.
//
// This script does NOT re-run selection. `status` is never modified for any
// row, under any circumstance — every gate/rank check below is reported only,
// never applied. A row the fresh Apify response doesn't return is left
// completely untouched (Instagram may simply not return older posts).
//
// Usage:
//   npx tsx scripts/refresh-metrics.ts [--apply] [--fetch N]
//
// Dry run by default: computes and prints the full report, writes nothing.
// --apply writes the updated manifests (via the shared atomic saveManifest)
// and, before the first write, backs up every manifest.json in
// datasets/raw/<handle>/ to manifest.json.bak-<timestamp> in the same dir.
//
// Global constraint: this script may only ADD to scrape-instagram.ts (export
// expectedViewsBaseline + the two mode constants, no behavioural change) and
// may only IMPORT from scripts/lib/*.ts, never edit it. Everything else
// scrape-instagram.ts does internally (Apify call shape, field normalization)
// is deliberately re-implemented here rather than imported, per that
// constraint — kept as close to the original as possible; see comments below
// at each point of duplication.

import fs from 'node:fs/promises';
import path from 'node:path';
import { loadEnvLocal, requireEnv } from './lib/load-env';
import { loadManifest, saveManifest, type ManifestEntry } from './lib/manifest';
import { expectedViewsBaseline, DEFAULT_OUTLIER_MULTIPLIER, DEFAULT_LIMIT_TOP_BOTTOM } from './scrape-instagram';

const ACTOR_ID = 'apify~instagram-reel-scraper';
const DEFAULT_FETCH = 250;

type RawItem = Record<string, unknown>;

// manifest.ts is off-limits to edit, so metricsRefreshedAt is layered on
// locally rather than added to the shared ManifestEntry type. It still lands
// in the written JSON fine — TS types don't affect what JSON.stringify emits.
type RefreshEntry = ManifestEntry & { metricsRefreshedAt?: string };

type CliArgs = { apply: boolean; fetch: number };

function parseArgs(argv: string[]): CliArgs {
  let apply = false;
  let fetchLimit = DEFAULT_FETCH;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--apply') apply = true;
    else if (a === '--fetch') fetchLimit = parseInt(argv[++i], 10);
  }
  return { apply, fetch: fetchLimit };
}

// ---------------------------------------------------------------------------
// Replicated from scrape-instagram.ts (pick/toNumber/normalizeTimestamp/
// runApifyActor/ageDaysSince). Not imported: the task constraints allow
// exporting only expectedViewsBaseline + the mode constants from that file.
// Kept identical in behaviour to avoid silently diverging on field precedence.
// ---------------------------------------------------------------------------

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

function ageDaysSince(postedAt: string | null | undefined): number | null {
  if (!postedAt) return null;
  const posted = new Date(postedAt).getTime();
  if (Number.isNaN(posted)) return null;
  return Math.max(1, Math.round((Date.now() - posted) / 86_400_000));
}

type FreshMetrics = {
  shortcode: string;
  permalink: string;
  views: number | null;
  likes: number | null;
  comments: number | null;
  postedAt: string | null;
};

function normalizeFresh(item: RawItem): FreshMetrics | null {
  const shortcode = pick(item, ['shortCode', 'shortcode', 'code']) as string | undefined;
  if (!shortcode) return null;
  return {
    shortcode,
    permalink: (pick(item, ['url', 'postUrl', 'link']) as string) ?? `https://www.instagram.com/reel/${shortcode}/`,
    // Same precedence as the fixed scrape-instagram.ts:195 — videoPlayCount
    // first, deliberately. See docs/findings/2026-08-02-view-metric-inconsistency.md
    views: toNumber(pick(item, ['videoPlayCount', 'playsCount', 'videoViewCount', 'viewCount'])),
    likes: toNumber(pick(item, ['likesCount', 'likeCount'])),
    comments: toNumber(pick(item, ['commentsCount', 'commentCount'])),
    postedAt: normalizeTimestamp(pick(item, ['timestamp', 'takenAt', 'takenAtTimestamp', 'postedAt'])),
  };
}

// Same call shape as scrape-instagram.ts's runApifyActor. No onlyPostsNewerThan
// filter — we want whatever recent window Apify hands back so we can match
// existing rows by shortcode regardless of when they were originally scraped,
// and so genuinely new candidates outside any prior window still surface.
async function runApifyActor(handle: string, resultsLimit: number): Promise<RawItem[]> {
  const url = `https://api.apify.com/v2/acts/${ACTOR_ID}/run-sync-get-dataset-items?token=${process.env.APIFY_API_TOKEN}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: [handle], resultsLimit }),
  });
  if (!res.ok) {
    throw new Error(`Apify actor call failed: ${res.status} ${await res.text()}`);
  }
  return (await res.json()) as RawItem[];
}

// ---------------------------------------------------------------------------
// Report types
// ---------------------------------------------------------------------------

type SelectionFlag = { shortcode: string; permalink: string; status: string; views: number | null; multiplier: number };
type RankChange = { shortcode: string; oldRank?: 'top' | 'bottom'; newRank?: 'top' | 'bottom'; applied: boolean };
type NewCandidate = { shortcode: string; permalink: string; postedAt: string | null; views: number; multiple: number };

type CreatorReport = {
  handle: string;
  mode: 'outliers' | 'top-bottom';
  totalRows: number;
  matched: number;
  untouched: number;
  oldBaseline: number;
  newBaseline: number;
  baselineRatio: number | null;
  wouldFailGate: SelectionFlag[];
  wouldNowPass: SelectionFlag[];
  rankChanges: RankChange[];
  newCandidates: NewCandidate[];
  includedDateRange: { min: string | null; max: string | null };
  finalEntries: RefreshEntry[];
};

type FailedCreator = { handle: string; error: string };

// ---------------------------------------------------------------------------
// Per-creator processing
// ---------------------------------------------------------------------------

async function processCreator(handle: string, dir: string, args: CliArgs, nowIso: string): Promise<CreatorReport> {
  const manifest = (await loadManifest(dir)) as RefreshEntry[];

  // Mode inference (manifest doesn't record which mode a creator was scraped
  // in): any row carrying a `rank` field means top-bottom mode. Only
  // henryjwade currently qualifies.
  const isTopBottom = manifest.some((e) => e.rank !== undefined);
  const mode: 'outliers' | 'top-bottom' = isTopBottom ? 'top-bottom' : 'outliers';

  const raw = await runApifyActor(handle, args.fetch); // throws -> caller skips this creator entirely

  const freshByShortcode = new Map<string, FreshMetrics>();
  for (const item of raw) {
    const f = normalizeFresh(item);
    if (f) freshByShortcode.set(f.shortcode, f);
  }

  const existingShortcodes = new Set(manifest.map((e) => e.shortcode));

  // Pass 1: apply views/likes/comments/metricsRefreshedAt to matched rows
  // ONLY. Unmatched rows are copied through with zero modification — no new
  // object identity even, so there is no risk of an incidental field change.
  let matched = 0;
  let untouched = 0;
  const afterMetrics: RefreshEntry[] = manifest.map((entry) => {
    const fresh = freshByShortcode.get(entry.shortcode);
    if (!fresh) {
      untouched++;
      return entry;
    }
    matched++;
    return {
      ...entry,
      views: fresh.views,
      likes: fresh.likes,
      comments: fresh.comments,
      metricsRefreshedAt: nowIso,
    };
  });

  // Baselines: same algorithm (expectedViewsBaseline), same invocation shape
  // as scrape-instagram.ts (`?? 0` then filter to > 0), computed once over
  // the OLD manifest and once over the post-refresh state (refreshed views
  // for matched rows, untouched-original views for everything else).
  const oldBaseline = expectedViewsBaseline(manifest.map((e) => e.views ?? 0).filter((v) => v > 0));
  const newBaseline = expectedViewsBaseline(afterMetrics.map((e) => e.views ?? 0).filter((v) => v > 0));
  const baselineRatio = oldBaseline > 0 ? newBaseline / oldBaseline : null;

  // Pass 2: recompute outlierMultiplier + viewsPerDay — but ONLY for matched
  // rows. Recomputing these for an untouched row would violate "left
  // completely untouched" even though the values themselves are derived, not
  // primary data.
  const finalEntries: RefreshEntry[] = afterMetrics.map((entry) => {
    const wasMatched = freshByShortcode.has(entry.shortcode);
    if (!wasMatched) return entry;
    if (entry.views === null || entry.views === undefined) return entry;
    const multiplier = newBaseline > 0 ? entry.views / newBaseline : 0;
    const days = ageDaysSince(entry.postedAt);
    const viewsPerDay = days !== null ? entry.views / Math.max(1, days) : entry.viewsPerDay;
    return { ...entry, outlierMultiplier: multiplier, viewsPerDay };
  });

  // --- Selection check (report only, never act on it) -----------------------

  const wouldFailGate: SelectionFlag[] = [];
  const wouldNowPass: SelectionFlag[] = [];
  if (mode === 'outliers') {
    for (const e of finalEntries) {
      if (e.views === null || e.views === undefined) continue;
      const multiplier = newBaseline > 0 ? e.views / newBaseline : 0;
      if (e.status === 'included' && multiplier < DEFAULT_OUTLIER_MULTIPLIER) {
        wouldFailGate.push({ shortcode: e.shortcode, permalink: e.permalink, status: e.status, views: e.views, multiplier });
      }
      if ((e.status === 'excluded_low_views' || e.status === 'excluded_rank') && multiplier >= DEFAULT_OUTLIER_MULTIPLIER) {
        wouldNowPass.push({ shortcode: e.shortcode, permalink: e.permalink, status: e.status, views: e.views, multiplier });
      }
    }
  }

  // --- Rank recompute (top-bottom mode only) --------------------------------
  //
  // Applied to matched rows (a factual relabel among already-included videos,
  // not a change to which videos are in the corpus). NOT applied to unmatched
  // rows — those stay completely untouched per the constraint above — but
  // still included in the *report* of which rank labels would change, since
  // that's informative even though we can't act on it for that row.
  const rankChanges: RankChange[] = [];
  let topThreshold: number | null = null;
  if (mode === 'top-bottom') {
    const rankBearing = finalEntries.filter((e) => e.rank !== undefined);
    const withViews = rankBearing.map((e) => ({
      shortcode: e.shortcode,
      views: e.views ?? 0,
      oldRank: e.rank,
      wasMatched: freshByShortcode.has(e.shortcode),
    }));
    const N = DEFAULT_LIMIT_TOP_BOTTOM;
    const byViews = [...withViews].sort((a, b) => b.views - a.views);
    const top = byViews.slice(0, N);
    const bottomPool = byViews.slice(N);
    const bottom = bottomPool.slice(-N);
    const topSet = new Set(top.map((x) => x.shortcode));
    const bottomSet = new Set(bottom.map((x) => x.shortcode));
    topThreshold = top.length > 0 ? top[top.length - 1].views : null;

    for (const x of withViews) {
      const newRank: 'top' | 'bottom' | undefined = topSet.has(x.shortcode)
        ? 'top'
        : bottomSet.has(x.shortcode)
          ? 'bottom'
          : undefined;
      if (newRank !== x.oldRank) {
        rankChanges.push({ shortcode: x.shortcode, oldRank: x.oldRank, newRank, applied: x.wasMatched });
      }
      if (x.wasMatched && newRank !== undefined && newRank !== x.oldRank) {
        const idx = finalEntries.findIndex((e) => e.shortcode === x.shortcode);
        finalEntries[idx] = { ...finalEntries[idx], rank: newRank };
      }
    }
  }

  // --- New candidates: fresh items Apify returned that aren't in the manifest
  // at all, and would pass the gate under the corrected baseline. Report only
  // — never added to the manifest. -----------------------------------------
  const newCandidates: NewCandidate[] = [];
  for (const [shortcode, fresh] of freshByShortcode) {
    if (existingShortcodes.has(shortcode)) continue;
    if (fresh.views === null || fresh.views <= 0) continue;
    if (mode === 'outliers') {
      const multiplier = newBaseline > 0 ? fresh.views / newBaseline : 0;
      if (multiplier >= DEFAULT_OUTLIER_MULTIPLIER) {
        newCandidates.push({ shortcode, permalink: fresh.permalink, postedAt: fresh.postedAt, views: fresh.views, multiple: multiplier });
      }
    } else {
      // top-bottom mode has no outlier gate. "Would pass" is interpreted here
      // as "would land in the recomputed top-N by views" — i.e. a potential
      // best-performer that was missed — not the bottom-N, since a missed
      // flop isn't the failure mode this report cares about. Documented
      // assumption; see report note.
      if (topThreshold !== null && fresh.views >= topThreshold) {
        const multiple = newBaseline > 0 ? fresh.views / newBaseline : 0;
        newCandidates.push({ shortcode, permalink: fresh.permalink, postedAt: fresh.postedAt, views: fresh.views, multiple });
      }
    }
  }
  newCandidates.sort((a, b) => b.views - a.views);

  const includedPosted = manifest.filter((e) => e.status === 'included').map((e) => e.postedAt).filter((d): d is string => !!d);
  const includedDateRange = {
    min: includedPosted.length > 0 ? includedPosted.reduce((a, b) => (a < b ? a : b)) : null,
    max: includedPosted.length > 0 ? includedPosted.reduce((a, b) => (a > b ? a : b)) : null,
  };

  if (args.apply) {
    await saveManifest(dir, finalEntries);
  }

  return {
    handle,
    mode,
    totalRows: manifest.length,
    matched,
    untouched,
    oldBaseline,
    newBaseline,
    baselineRatio,
    wouldFailGate,
    wouldNowPass,
    rankChanges,
    newCandidates,
    includedDateRange,
    finalEntries,
  };
}

// ---------------------------------------------------------------------------
// Backup (apply mode only, before any write)
// ---------------------------------------------------------------------------

async function backupAllManifests(rawRoot: string, creatorDirs: string[], fileTimestamp: string): Promise<string[]> {
  const backups: string[] = [];
  for (const handle of creatorDirs) {
    const src = path.join(rawRoot, handle, 'manifest.json');
    try {
      await fs.access(src);
    } catch {
      continue;
    }
    const dest = path.join(rawRoot, handle, `manifest.json.bak-${fileTimestamp}`);
    await fs.copyFile(src, dest);
    backups.push(dest);
  }
  return backups;
}

// ---------------------------------------------------------------------------
// Report rendering
// ---------------------------------------------------------------------------

function fmtNum(n: number | null | undefined): string {
  if (n === null || n === undefined) return 'n/a';
  return Math.round(n).toLocaleString();
}

function fmtRatio(n: number | null): string {
  if (n === null) return 'n/a';
  return `${n.toFixed(2)}x`;
}

function renderCreatorSection(r: CreatorReport): string {
  const lines: string[] = [];
  lines.push(`## @${r.handle} (${r.mode} mode)`);
  lines.push('');
  lines.push(`- rows in manifest: ${r.totalRows}`);
  lines.push(`- matched & refreshed: ${r.matched}`);
  lines.push(`- not returned by Apify this run (left untouched): ${r.untouched}`);
  lines.push(`- baseline: old ${fmtNum(r.oldBaseline)} -> new ${fmtNum(r.newBaseline)} (ratio ${fmtRatio(r.baselineRatio)})`);
  lines.push('');

  if (r.mode === 'outliers') {
    lines.push(`**Selection check** (report only — status NOT modified):`);
    lines.push(`- currently \`included\` rows that would NOT pass the ${DEFAULT_OUTLIER_MULTIPLIER}x gate now: ${r.wouldFailGate.length}`);
    for (const f of r.wouldFailGate) {
      lines.push(`  - ${f.shortcode}: ${fmtNum(f.views)} views, ${f.multiplier.toFixed(2)}x baseline — ${f.permalink}`);
    }
    lines.push(`- currently excluded (excluded_low_views/excluded_rank) rows that WOULD now pass: ${r.wouldNowPass.length}`);
    for (const f of r.wouldNowPass) {
      lines.push(`  - ${f.shortcode} (${f.status}): ${fmtNum(f.views)} views, ${f.multiplier.toFixed(2)}x baseline — ${f.permalink}`);
    }
  } else {
    lines.push(`**Selection check** (report only — status NOT modified; rank IS recomputed/applied for matched rows, see below):`);
    lines.push(`- top-bottom mode has no outlier gate, so the include/exclude gate check above doesn't apply.`);
    lines.push(`- rank label changes: ${r.rankChanges.length}`);
    for (const c of r.rankChanges) {
      lines.push(
        `  - ${c.shortcode}: ${c.oldRank ?? '(none)'} -> ${c.newRank ?? '(none)'} ${c.applied ? '[applied]' : '[NOT applied — row untouched, no fresh data this run]'}`,
      );
    }
  }
  lines.push('');

  lines.push(`**New candidates** (in Apify's response, not in the manifest at all, would pass the corrected gate): ${r.newCandidates.length}`);
  lines.push(
    `- existing \`included\` rows date range: ${r.includedDateRange.min ?? 'n/a'} to ${r.includedDateRange.max ?? 'n/a'} (for human judgment on whether a candidate falls inside the originally-scraped window — not filtered automatically)`,
  );
  for (const c of r.newCandidates) {
    lines.push(`  - ${c.shortcode}: ${fmtNum(c.views)} views, ${c.multiple.toFixed(2)}x baseline, posted ${c.postedAt ?? 'unknown'} — ${c.permalink}`);
  }
  lines.push('');
  return lines.join('\n');
}

function buildReport(
  reports: CreatorReport[],
  failed: FailedCreator[],
  args: CliArgs,
  backups: string[],
  runTimestamp: string,
): string {
  const lines: string[] = [];
  lines.push(`# Metrics refresh report`);
  lines.push('');
  lines.push(`Run: ${runTimestamp} — mode: ${args.apply ? 'APPLY (manifests written)' : 'DRY RUN (nothing written)'} — fetch limit: ${args.fetch} per creator`);
  lines.push('');

  const totalRows = reports.reduce((s, r) => s + r.totalRows, 0);
  const totalMatched = reports.reduce((s, r) => s + r.matched, 0);
  const totalUntouched = reports.reduce((s, r) => s + r.untouched, 0);
  const totalWouldFail = reports.reduce((s, r) => s + r.wouldFailGate.length, 0);
  const totalWouldPass = reports.reduce((s, r) => s + r.wouldNowPass.length, 0);
  const totalNewCandidates = reports.reduce((s, r) => s + r.newCandidates.length, 0);
  const totalRankChanges = reports.reduce((s, r) => s + r.rankChanges.length, 0);

  lines.push(`## Overall summary`);
  lines.push('');
  lines.push(`- creators processed: ${reports.length} / ${reports.length + failed.length}`);
  lines.push(`- creators failed (skipped, unmodified): ${failed.length}`);
  for (const f of failed) lines.push(`  - @${f.handle}: ${f.error}`);
  lines.push(`- total manifest rows: ${totalRows}`);
  lines.push(`- total matched & refreshed: ${totalMatched}`);
  lines.push(`- total untouched (not returned by Apify): ${totalUntouched}`);
  lines.push(`- total currently-\`included\` rows that would now fail the gate: ${totalWouldFail}`);
  lines.push(`- total currently-excluded rows that would now pass the gate: ${totalWouldPass}`);
  lines.push(`- total rank label changes (top-bottom mode): ${totalRankChanges}`);
  lines.push(`- total new candidates found: ${totalNewCandidates}`);
  if (backups.length > 0) {
    lines.push(`- manifest backups written (${backups.length}):`);
    for (const b of backups) lines.push(`  - ${b}`);
  }
  lines.push('');
  lines.push(`---`);
  lines.push('');

  for (const r of reports) {
    lines.push(renderCreatorSection(r));
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  loadEnvLocal();
  requireEnv(['APIFY_API_TOKEN']);
  const args = parseArgs(process.argv.slice(2));

  const rawRoot = path.join(process.cwd(), 'datasets', 'raw');
  const dirents = await fs.readdir(rawRoot, { withFileTypes: true });
  const creatorDirs = dirents.filter((d) => d.isDirectory()).map((d) => d.name).sort();

  console.log('='.repeat(78));
  console.log(
    `COST WARNING: this fetches up to ${args.fetch} results per creator across ${creatorDirs.length} creators ` +
      `(~${(args.fetch * creatorDirs.length).toLocaleString()} results total) from Apify's ${ACTOR_ID} actor. This consumes Apify credits.`,
  );
  console.log(
    args.apply
      ? 'Running in --apply mode: manifests WILL be modified (after a full backup of every manifest.json).'
      : 'Running in DRY RUN mode (default): nothing will be written. Pass --apply to write.',
  );
  console.log('='.repeat(78));

  const runTimestamp = new Date().toISOString();
  let backups: string[] = [];
  if (args.apply) {
    const fileTimestamp = runTimestamp.replace(/[:.]/g, '-'); // ':' is invalid in Windows filenames
    backups = await backupAllManifests(rawRoot, creatorDirs, fileTimestamp);
    console.log(`Backed up ${backups.length} manifest(s) before any write:`);
    for (const b of backups) console.log(`  ${b}`);
  }

  const reports: CreatorReport[] = [];
  const failed: FailedCreator[] = [];

  for (const handle of creatorDirs) {
    const dir = path.join(rawRoot, handle);
    console.log(`\n@${handle}: fetching up to ${args.fetch} reels from Apify...`);
    try {
      const report = await processCreator(handle, dir, args, runTimestamp);
      reports.push(report);
      console.log(
        `@${handle}: ${report.matched} matched / ${report.untouched} untouched, baseline ${fmtNum(report.oldBaseline)} -> ${fmtNum(report.newBaseline)} (${fmtRatio(report.baselineRatio)}), ${report.newCandidates.length} new candidate(s).`,
      );
    } catch (e) {
      const message = (e as Error).message;
      console.error(`@${handle}: FAILED — ${message} — skipping this creator, manifest untouched.`);
      failed.push({ handle, error: message });
    }
  }

  const reportText = buildReport(reports, failed, args, backups, runTimestamp);
  console.log('\n' + reportText);

  const reportPath = path.join(rawRoot, '_metrics-refresh-report.md');
  await fs.writeFile(reportPath, reportText, 'utf8');
  console.log(`\nFull report written to ${reportPath}`);
  if (!args.apply) {
    console.log('This was a DRY RUN — no manifest was modified. Re-run with --apply to write.');
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
