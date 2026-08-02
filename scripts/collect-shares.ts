// Collects Instagram share counts from SocialCrawl for every `included` row
// across all 14 creators, and — since SocialCrawl returns views/likes/comments
// in the same payload at no extra cost — independently audits those numbers
// against the Apify-sourced metrics already stored on each row.
//
// Usage:
//   npm run collect:shares
//
// SocialCrawl API (base https://www.socialcrawl.dev/v1, header x-api-key):
//   GET /instagram/profile/reels/full?handle=<handle>&limit=<n>[&cursor=<c>]
//
// Response shape, verified live against real handles before writing this
// script (see .superpowers/sdd/2026-07-31-burn-in-title-ocr/collect-shares-report.md
// for the full probe transcripts):
//
//   {
//     success: boolean,
//     data: {
//       items: [{
//         post: {
//           id: string,                 // numeric internal media id — NOT the
//                                        // shortcode, not usable for matching
//           url: string,                // e.g. https://www.instagram.com/reel/<shortcode>/
//           published_at: string,       // ISO datetime, newest-first ordering
//           engagement: { views, likes, comments, shares, saves },
//         },
//         computed: { engagement_rate, estimated_reach, ... },
//       }],
//       pages_consumed, shares_fanout_calls, dropped, _warnings,
//     },
//     credits_used: number,             // cost of THIS call
//     credits_remaining: number,        // balance AFTER this call
//     cached: boolean,
//     pagination: { next_cursor: string, has_more: boolean, page_size: number },
//   }
//
// The shortcode is derived by parsing the last path segment of `post.url`
// (e.g. ".../reel/DbdpahFtzyV/" -> "DbdpahFtzyV"), which matches the
// `shortcode` field already stored in every manifest row exactly (both this
// scraper and Apify use Instagram's public shortcode). `post.id` is a
// different, much longer numeric media id and cannot be used for matching.
//
// Pagination uses the top-level `pagination.next_cursor` / `has_more` fields,
// passed back as the `cursor` query parameter on the next call. Verified live:
// a second call with `cursor` set returns the next chronological page (no
// overlap with the first), and item ordering is consistently newest-first by
// `published_at`.
//
// COST MODEL (measured, not documented by the vendor): a call's credits_used
// is NOT simply 0.5 * items-returned. Each call carries a flat ~1 credit
// "list" cost plus ~0.5 credits per reel SocialCrawl had to fetch from
// Instagram to satisfy the page internally (which can exceed the requested
// `limit` when the request is truncated mid-page — seen as the
// `limit_truncated_mid_page` warning). Requesting a small `limit` repeatedly
// wastes this fanout cost; requesting closer to the actual number of items
// needed in fewer, larger calls is more efficient. Measured effective rate
// across live probes: ~0.5-1.1 credits per returned item, still comfortably
// inside the stated ~473-credit estimate for depth-965 total (see fetch-depth
// note below) against a 2,511-credit balance.
//
// FETCH DEPTH — literal spec vs. what actually works:
// The task spec defines "depth" as a position count: sort a creator's
// manifest newest-first by postedAt, find the index of the oldest `included`
// row, depth = that index + 1. `positionDepth` is used purely as a SIZING
// HINT for the first request (and to align with a prior run's request shape
// for cache hits, see RESUME below) — it is NOT the stopping condition.
//
// STOPPING CONDITION — coverage-based, NOT date-based (round 2 fix):
// An earlier version of this script stopped paging as soon as an item older
// than the target row's `postedAt` appeared, on the assumption SocialCrawl
// returns reels in strict reverse-chronological order. That assumption is
// FALSE: live runs showed out-of-order items (e.g. `bielvalldo` produced a
// 2025-08-05 item mid-stream while several 2026 `included` rows were still
// unmatched), which ended the walk early and left real, reachable rows
// uncollected. The stopping rule is now purely coverage-based: keep paging
// until EITHER (a) every still-missing target shortcode for the creator has
// been matched, OR (b) the cursor is exhausted (`has_more: false`), OR (c) a
// hard page cap (`manifest.length * HARD_CAP_MULTIPLIER`) is hit — a backstop
// against a creator whose target rows are genuinely absent from SocialCrawl's
// feed (verified: itisbainz's two `included` rows are provably absent — no
// amount of paging would ever find them) so a search doesn't run away
// indefinitely. The global credit-floor abort remains the ultimate backstop.
//
// RESUME — only fetch what's missing:
// Before paging, each creator's `included` shortcodes that already carry an
// `entry.socialcrawl` object (from a prior run) are treated as done and
// excluded from the target set — re-fetching them would spend credits
// re-buying data already on disk. A creator whose target set is empty after
// this filter is skipped entirely (zero API calls). Because SocialCrawl
// caches identical (handle, limit, cursor) requests, restarting the walk from
// `cursor: null` each run is cheap where it overlaps with prior coverage —
// verified live: cached responses report `credits_used: 0`. Cached responses
// ALSO report `credits_remaining: 0`, which is a vendor bug, not a real
// balance — the credit-floor check below only trusts `credits_remaining` on
// responses where `cached === false`.
//
// TRANSIENT FAILURES:
// SocialCrawl occasionally returns a 504 (`FUNCTION_INVOCATION_TIMEOUT`) on
// an otherwise-valid request — a live run saw this abandon two creators
// entirely (`bycarlosroberto` 0/7, `henryjwade` 54/93) on the very first
// timeout. Every call is now retried up to 3 times with backoff (2s, 6s,
// 15s) before being treated as a real failure. A `CreditFloorError` is never
// retried — that one is a deliberate, immediate abort.

import fs from 'node:fs/promises';
import path from 'node:path';
import { loadEnvLocal, requireEnv } from './lib/load-env';
import { loadManifest, saveManifest, type ManifestEntry } from './lib/manifest';

const API_BASE = 'https://www.socialcrawl.dev/v1';
const ENDPOINT = '/instagram/profile/reels/full';
const CREDIT_FLOOR = 300; // abort the whole run if credits_remaining (from a non-cached response) drops below this
const PAGE_LIMIT_MAX = 40; // per-call `limit`, once past the initial depth-sized request
const HARD_CAP_MULTIPLIER = 2; // hard page cap per creator = manifest.length * this, backstop only
const RETRY_DELAYS_MS = [2000, 6000, 15000]; // backoff before retry 1, 2, 3 on a transient call failure

type SocialCrawlMetrics = {
  views: number | null;
  likes: number | null;
  comments: number | null;
  shares: number | null;
  engagementRate: number | null;
  estimatedReach: number | null;
  fetchedAt: string;
};

// manifest.ts is off-limits to edit, so the `socialcrawl` field is layered on
// locally rather than added to the shared ManifestEntry type — it still lands
// in the written JSON fine, JSON.stringify doesn't care about TS types.
type Entry = ManifestEntry & { socialcrawl?: SocialCrawlMetrics };

type RawItem = {
  post: {
    id: string;
    url: string;
    published_at: string;
    engagement: {
      views: number | null;
      likes: number | null;
      comments: number | null;
      shares: number | null;
      saves: number | null;
    };
  };
  computed?: {
    engagement_rate?: number | null;
    estimated_reach?: number | null;
  };
};

type ApiResponse = {
  success: boolean;
  data: {
    items: RawItem[];
    _warnings?: string[];
  };
  credits_used: number;
  credits_remaining: number;
  cached: boolean;
  pagination: {
    next_cursor: string | null;
    has_more: boolean;
    page_size: number;
  };
};

function shortcodeFromUrl(url: string): string | null {
  try {
    const segments = new URL(url).pathname.split('/').filter(Boolean);
    return segments.length > 0 ? segments[segments.length - 1] : null;
  } catch {
    return null;
  }
}

// -----------------------------------------------------------------------
// Fetch depth
// -----------------------------------------------------------------------

type DepthInfo = {
  positionDepth: number; // sizing hint only — NOT the stopping condition, see header comment
  includedShortcodes: Set<string>;
};

function computeDepth(manifest: Entry[]): DepthInfo {
  const sorted = [...manifest].sort((a, b) => (b.postedAt ?? '').localeCompare(a.postedAt ?? ''));
  let lastIncludedIdx = -1;
  sorted.forEach((e, i) => {
    if (e.status === 'included') lastIncludedIdx = i;
  });
  const positionDepth = lastIncludedIdx + 1;
  const includedShortcodes = new Set(manifest.filter((e) => e.status === 'included').map((e) => e.shortcode));
  return { positionDepth, includedShortcodes };
}

// -----------------------------------------------------------------------
// Budget tracking (shared across all creators, checked after every call)
// -----------------------------------------------------------------------

type Budget = {
  startingBalance: number | null;
  currentBalance: number | null;
  totalConsumed: number;
  aborted: boolean;
};

class CreditFloorError extends Error {
  constructor(public remaining: number) {
    super(`credits_remaining (${remaining}) dropped below the ${CREDIT_FLOOR} floor — aborting run`);
  }
}

async function callApi(apiKey: string, handle: string, limit: number, cursor: string | null, budget: Budget): Promise<ApiResponse> {
  const url = new URL(API_BASE + ENDPOINT);
  url.searchParams.set('handle', handle);
  url.searchParams.set('limit', String(limit));
  if (cursor) url.searchParams.set('cursor', cursor);

  const res = await fetch(url.toString(), { headers: { 'x-api-key': apiKey } });
  if (!res.ok) {
    throw new Error(`SocialCrawl API call failed: ${res.status} ${await res.text()}`);
  }
  const body = (await res.json()) as ApiResponse;
  if (!body.success) {
    throw new Error(`SocialCrawl API returned success:false for @${handle}`);
  }

  // credits_used is trusted regardless of `cached` (a cached hit legitimately
  // costs 0). credits_remaining is a DIFFERENT story: a cached response
  // reports credits_remaining: 0, which is a confirmed vendor bug, not a real
  // balance — a floor check that trusted it would abort a perfectly healthy
  // run. Only non-cached responses update the tracked balance / trip the
  // floor guard.
  budget.totalConsumed += body.credits_used;
  if (!body.cached) {
    if (budget.startingBalance === null) {
      budget.startingBalance = body.credits_remaining + budget.totalConsumed;
    }
    budget.currentBalance = body.credits_remaining;
    if (body.credits_remaining < CREDIT_FLOOR) {
      budget.aborted = true;
      throw new CreditFloorError(body.credits_remaining);
    }
  }

  return body;
}

// Retries a transient call failure (e.g. the 504 FUNCTION_INVOCATION_TIMEOUT
// SocialCrawl occasionally returns) up to RETRY_DELAYS_MS.length times with
// backoff, so one timeout doesn't cost an entire creator's progress. A
// CreditFloorError is a deliberate abort, never retried.
async function callApiWithRetry(apiKey: string, handle: string, limit: number, cursor: string | null, budget: Budget): Promise<ApiResponse> {
  let lastErr: Error | undefined;
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    try {
      return await callApi(apiKey, handle, limit, cursor, budget);
    } catch (e) {
      if (e instanceof CreditFloorError) throw e;
      lastErr = e as Error;
      if (attempt < RETRY_DELAYS_MS.length) {
        const delay = RETRY_DELAYS_MS[attempt];
        console.warn(`  @${handle}: transient error (attempt ${attempt + 1}/${RETRY_DELAYS_MS.length + 1}): ${lastErr.message} — retrying in ${delay}ms`);
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  }
  throw lastErr;
}

// -----------------------------------------------------------------------
// Per-creator collection
// -----------------------------------------------------------------------

type CreatorReport = {
  handle: string;
  includedTotal: number;
  alreadyCovered: number; // included rows that already had entry.socialcrawl before this run
  targetThisRun: number; // includedTotal - alreadyCovered
  positionDepth: number;
  itemsFetched: number;
  apiCalls: number;
  creditsUsed: number;
  matchedThisRun: number;
  stopReason: string;
  error?: string;
  aborted?: boolean;
};

async function collectForCreator(
  apiKey: string,
  handle: string,
  dir: string,
  budget: Budget,
  nowIso: string,
): Promise<CreatorReport> {
  const manifest = (await loadManifest(dir)) as Entry[];
  const { positionDepth, includedShortcodes } = computeDepth(manifest);

  // Resume: exclude any `included` shortcode that already carries
  // entry.socialcrawl from a prior run — re-fetching it would spend credits
  // re-buying data already on disk.
  const alreadyCoveredSet = new Set(
    manifest.filter((e) => includedShortcodes.has(e.shortcode) && e.socialcrawl != null).map((e) => e.shortcode),
  );
  const targetShortcodes = new Set([...includedShortcodes].filter((sc) => !alreadyCoveredSet.has(sc)));

  const report: CreatorReport = {
    handle,
    includedTotal: includedShortcodes.size,
    alreadyCovered: alreadyCoveredSet.size,
    targetThisRun: targetShortcodes.size,
    positionDepth,
    itemsFetched: 0,
    apiCalls: 0,
    creditsUsed: 0,
    matchedThisRun: 0,
    stopReason: 'not started',
  };

  if (includedShortcodes.size === 0) {
    report.stopReason = 'no included rows — skipped';
    return report;
  }
  if (targetShortcodes.size === 0) {
    report.stopReason = 'already fully covered — skipped (0 API calls)';
    return report;
  }

  const hardCap = Math.max(manifest.length * HARD_CAP_MULTIPLIER, PAGE_LIMIT_MAX);
  const fetched = new Map<
    string,
    { views: number | null; likes: number | null; comments: number | null; shares: number | null; engagementRate: number | null; estimatedReach: number | null }
  >();
  const matchedThisRun = new Set<string>();

  let cursor: string | null = null;
  let hasMore = true;
  const creditsBefore = budget.totalConsumed;

  try {
    while (hasMore) {
      const remainingToPositionDepth = Math.max(positionDepth - report.itemsFetched, 0);
      const limit = remainingToPositionDepth > 0 ? Math.min(remainingToPositionDepth, PAGE_LIMIT_MAX) : PAGE_LIMIT_MAX;

      const body = await callApiWithRetry(apiKey, handle, limit, cursor, budget);
      report.apiCalls++;

      for (const item of body.data.items) {
        const sc = shortcodeFromUrl(item.post.url);
        if (!sc) continue;
        report.itemsFetched++;
        // Already-covered shortcodes are skipped for matching/merge purposes
        // (never overwrite existing data), even if the (cached) page happens
        // to include them again.
        if (!targetShortcodes.has(sc) || alreadyCoveredSet.has(sc)) continue;

        fetched.set(sc, {
          views: item.post.engagement.views ?? null,
          likes: item.post.engagement.likes ?? null,
          comments: item.post.engagement.comments ?? null,
          shares: item.post.engagement.shares ?? null,
          engagementRate: item.computed?.engagement_rate ?? null,
          estimatedReach: item.computed?.estimated_reach ?? null,
        });
        matchedThisRun.add(sc);
      }

      hasMore = body.pagination.has_more;
      cursor = body.pagination.next_cursor;

      if (matchedThisRun.size === targetShortcodes.size) {
        report.stopReason = 'all target rows matched';
        break;
      }
      if (!hasMore) {
        report.stopReason = `cursor exhausted (${matchedThisRun.size}/${targetShortcodes.size} target rows matched)`;
        break;
      }
      if (report.itemsFetched >= hardCap) {
        report.stopReason = `hard page cap reached (${hardCap} items; ${matchedThisRun.size}/${targetShortcodes.size} target rows matched)`;
        break;
      }
    }
    if (report.stopReason === 'not started') report.stopReason = 'loop ended unexpectedly';
  } catch (e) {
    if (e instanceof CreditFloorError) {
      report.aborted = true;
      report.stopReason = `ABORTED — ${e.message}`;
    } else {
      report.error = (e as Error).message;
      report.stopReason = `error after retries exhausted — ${report.error}`;
    }
  }

  report.matchedThisRun = matchedThisRun.size;
  report.creditsUsed = budget.totalConsumed - creditsBefore;

  // Merge into the manifest — ANY matched target row gets the data; existing
  // entry.socialcrawl values (already-covered rows) are never touched.
  const merged: Entry[] = manifest.map((entry) => {
    const fresh = fetched.get(entry.shortcode);
    if (!fresh || entry.socialcrawl != null) return entry;
    return {
      ...entry,
      socialcrawl: { ...fresh, fetchedAt: nowIso },
    };
  });
  await saveManifest(dir, merged);

  return report;
}

// -----------------------------------------------------------------------
// Backup (before any write)
// -----------------------------------------------------------------------

async function backupAllManifests(rawRoot: string, creatorDirs: string[], fileTimestamp: string): Promise<string[]> {
  const backups: string[] = [];
  for (const handle of creatorDirs) {
    const src = path.join(rawRoot, handle, 'manifest.json');
    try {
      await fs.access(src);
    } catch {
      continue;
    }
    const dest = path.join(rawRoot, handle, `manifest.json.scbak-${fileTimestamp}`);
    await fs.copyFile(src, dest);
    backups.push(dest);
  }
  return backups;
}

// -----------------------------------------------------------------------
// Audit
// -----------------------------------------------------------------------

function median(nums: number[]): number | null {
  if (nums.length === 0) return null;
  const sorted = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function pctDiff(a: number, b: number): number {
  const denom = Math.max(Math.abs(a), Math.abs(b), 1e-9);
  return (Math.abs(a - b) / denom) * 100;
}

function rankArray(values: number[]): number[] {
  const idx = values.map((_, i) => i).sort((a, b) => values[a] - values[b]);
  const ranks = new Array<number>(values.length);
  let i = 0;
  while (i < idx.length) {
    let j = i;
    while (j + 1 < idx.length && values[idx[j + 1]] === values[idx[i]]) j++;
    const avgRank = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) ranks[idx[k]] = avgRank;
    i = j + 1;
  }
  return ranks;
}

function spearman(xs: number[], ys: number[]): number | null {
  const n = xs.length;
  if (n < 2) return null;
  const rx = rankArray(xs);
  const ry = rankArray(ys);
  const mrx = rx.reduce((a, b) => a + b, 0) / n;
  const mry = ry.reduce((a, b) => a + b, 0) / n;
  let num = 0,
    dx2 = 0,
    dy2 = 0;
  for (let i = 0; i < n; i++) {
    const dx = rx[i] - mrx;
    const dy = ry[i] - mry;
    num += dx * dy;
    dx2 += dx * dx;
    dy2 += dy * dy;
  }
  if (dx2 === 0 || dy2 === 0) return null;
  return num / Math.sqrt(dx2 * dy2);
}

type MetricAgreement = {
  metric: string;
  n: number;
  within2: number;
  within5: number;
  within15: number;
  beyond15: number;
  spearman: number | null;
  worst: { shortcode: string; permalink: string; apify: number; socialcrawl: number; ratio: string; pctDiff: number }[];
};

function computeAgreement(rows: Entry[], metric: 'views' | 'likes' | 'comments'): MetricAgreement {
  const pairs: { shortcode: string; permalink: string; apify: number; socialcrawl: number }[] = [];
  for (const e of rows) {
    const apifyVal = e[metric];
    const scVal = e.socialcrawl?.[metric] ?? null;
    if (typeof apifyVal === 'number' && typeof scVal === 'number') {
      pairs.push({ shortcode: e.shortcode, permalink: e.permalink, apify: apifyVal, socialcrawl: scVal });
    }
  }
  let within2 = 0,
    within5 = 0,
    within15 = 0,
    beyond15 = 0;
  const withDiff = pairs.map((p) => ({ ...p, diff: pctDiff(p.apify, p.socialcrawl) }));
  for (const p of withDiff) {
    if (p.diff <= 2) within2++;
    else if (p.diff <= 5) within5++;
    else if (p.diff <= 15) within15++;
    else beyond15++;
  }
  const worst = [...withDiff]
    .sort((a, b) => b.diff - a.diff)
    .slice(0, 10)
    .map((p) => ({
      shortcode: p.shortcode,
      permalink: p.permalink,
      apify: p.apify,
      socialcrawl: p.socialcrawl,
      ratio: p.socialcrawl > 0 && p.apify > 0 ? `${(Math.max(p.apify, p.socialcrawl) / Math.min(p.apify, p.socialcrawl)).toFixed(2)}x` : 'n/a (zero value)',
      pctDiff: p.diff,
    }));
  const rho = spearman(
    pairs.map((p) => p.apify),
    pairs.map((p) => p.socialcrawl),
  );
  return { metric, n: pairs.length, within2, within5, within15, beyond15, spearman: rho, worst };
}

function fmtNum(n: number | null | undefined): string {
  if (n === null || n === undefined) return 'n/a';
  return Math.round(n).toLocaleString();
}

function buildAuditReport(
  allManifests: Map<string, Entry[]>,
  creatorReports: CreatorReport[],
  budget: Budget,
  runTimestamp: string,
  backups: string[],
): string {
  const lines: string[] = [];
  const includedRows: (Entry & { handle: string })[] = [];
  for (const [handle, entries] of allManifests) {
    for (const e of entries) if (e.status === 'included') includedRows.push({ ...e, handle });
  }

  lines.push('# Shares collection + metrics audit');
  lines.push('');
  lines.push(`Run: ${runTimestamp}`);
  lines.push('');
  lines.push(
    'Two things happened in one pass: SocialCrawl shares were collected for `included` rows (Apify has no share field at all), and since SocialCrawl returns views/likes/comments in the same payload at no extra cost, those were captured too as an independent cross-check against the Apify numbers already on each row — without overwriting them (`entry.socialcrawl` is a separate nested object; the top-level `views`/`likes`/`comments` fields are untouched).',
  );
  lines.push('');

  // --- Coverage --------------------------------------------------------
  const withShares = includedRows.filter((e) => typeof e.socialcrawl?.shares === 'number');
  const withoutShares = includedRows.filter((e) => !(typeof e.socialcrawl?.shares === 'number'));
  lines.push('## Shares coverage');
  lines.push('');
  lines.push(`${withShares.length} / ${includedRows.length} included rows got a numeric share count.`);
  lines.push('');
  if (withoutShares.length > 0) {
    lines.push('Rows without a share count (a null on a very-low-view video is expected; a null on a high-view video is not):');
    lines.push('');
    lines.push('| shortcode | handle | views (Apify) | permalink |');
    lines.push('|---|---|---:|---|');
    for (const e of [...withoutShares].sort((a, b) => (b.views ?? 0) - (a.views ?? 0))) {
      lines.push(`| ${e.shortcode} | ${e.handle} | ${fmtNum(e.views)} | ${e.permalink} |`);
    }
    lines.push('');
  }

  // --- Source agreement --------------------------------------------------
  lines.push('## Source agreement (Apify vs SocialCrawl, rows with both values present)');
  lines.push('');
  lines.push(
    '> Interpretation: an earlier check found the two sources agree to within 0.002% on views for a matched sample. Small differences here are expected — the Apify pull is hours older than this SocialCrawl pull, and view/like/comment counts drift continuously. Large or systematic differences would indicate a residual field problem (see `docs/findings/2026-08-02-view-metric-inconsistency.md`), not normal drift.',
  );
  lines.push('');

  for (const metric of ['views', 'likes', 'comments'] as const) {
    const agg = computeAgreement(includedRows, metric);
    lines.push(`### ${metric}`);
    lines.push('');
    lines.push(`n = ${agg.n} rows with both values.`);
    lines.push('');
    lines.push(`- within 2%: ${agg.within2}`);
    lines.push(`- within 5% (and beyond 2%): ${agg.within5}`);
    lines.push(`- within 15% (and beyond 5%): ${agg.within15}`);
    lines.push(`- beyond 15%: ${agg.beyond15}`);
    lines.push(`- Spearman rank correlation: ${agg.spearman === null ? 'n/a' : agg.spearman.toFixed(4)}`);
    lines.push('');
    if (agg.worst.length > 0) {
      lines.push(`10 largest disagreements:`);
      lines.push('');
      lines.push('| shortcode | apify | socialcrawl | ratio | % diff | permalink |');
      lines.push('|---|---:|---:|---:|---:|---|');
      for (const w of agg.worst) {
        lines.push(`| ${w.shortcode} | ${fmtNum(w.apify)} | ${fmtNum(w.socialcrawl)} | ${w.ratio} | ${w.pctDiff.toFixed(1)}% | ${w.permalink} |`);
      }
      lines.push('');
    }
  }

  // --- Share statistics ----------------------------------------------------
  lines.push('## Share statistics (included rows with a numeric share count)');
  lines.push('');
  const shareVals = withShares.map((e) => e.socialcrawl!.shares as number);
  lines.push(`- shares: min ${fmtNum(Math.min(...shareVals))}, median ${fmtNum(median(shareVals))}, max ${fmtNum(Math.max(...shareVals))}`);
  const shareRateRows = withShares.filter((e) => (e.socialcrawl?.views ?? 0) > 0);
  const shareRates = shareRateRows.map((e) => (e.socialcrawl!.shares as number) / (e.socialcrawl!.views as number));
  if (shareRates.length > 0) {
    lines.push(
      `- shares/views (using SocialCrawl's own contemporaneous views, n=${shareRates.length}): min ${(Math.min(...shareRates) * 100).toFixed(3)}%, median ${(median(shareRates)! * 100).toFixed(3)}%, max ${(Math.max(...shareRates) * 100).toFixed(3)}%`,
    );
  }
  const per100LikesRows = withShares.filter((e) => (e.socialcrawl?.likes ?? 0) > 0);
  const per100Likes = per100LikesRows.map((e) => ((e.socialcrawl!.shares as number) / (e.socialcrawl!.likes as number)) * 100);
  if (per100Likes.length > 0) {
    lines.push(
      `- shares per 100 likes (n=${per100Likes.length}): min ${Math.min(...per100Likes).toFixed(2)}, median ${median(per100Likes)!.toFixed(2)}, max ${Math.max(...per100Likes).toFixed(2)}`,
    );
  }
  lines.push('');

  // --- Credits --------------------------------------------------------
  lines.push('## Credits');
  lines.push('');
  lines.push(`- starting balance: ${fmtNum(budget.startingBalance)}`);
  lines.push(`- ending balance: ${fmtNum(budget.currentBalance)}`);
  lines.push(`- total consumed: ${fmtNum(budget.totalConsumed)}`);
  lines.push(`- aborted on credit floor: ${budget.aborted ? 'YES' : 'no'}`);
  lines.push('');
  lines.push('Per creator (this run):');
  lines.push('');
  lines.push('| handle | included | already covered | target this run | items fetched | api calls | credits used | matched this run | stop reason |');
  lines.push('|---|---:|---:|---:|---:|---:|---:|---:|---|');
  for (const r of creatorReports) {
    lines.push(
      `| ${r.handle} | ${r.includedTotal} | ${r.alreadyCovered} | ${r.targetThisRun} | ${r.itemsFetched} | ${r.apiCalls} | ${r.creditsUsed} | ${r.matchedThisRun}/${r.targetThisRun} | ${r.stopReason} |`,
    );
  }
  lines.push('');

  if (backups.length > 0) {
    lines.push('## Backups written before any manifest write');
    lines.push('');
    for (const b of backups) lines.push(`- ${b}`);
    lines.push('');
  }

  return lines.join('\n');
}

// -----------------------------------------------------------------------
// Retry-round summary (appended to the audit report)
// -----------------------------------------------------------------------

// Known from the completed first collection run (395 credits consumed,
// 111/175 coverage) — see the prior `_shares-audit.md` content this run
// overwrites. Used only to render a combined-total line; not used in any
// control-flow decision.
const ROUND1_CREDITS_CONSUMED = 395;

function buildRetryRoundSection(creatorReports: CreatorReport[], budget: Budget, allManifests: Map<string, Entry[]>): string {
  const lines: string[] = [];
  lines.push('## Retry round');
  lines.push('');
  lines.push('The first pass finished at 111/175 shares coverage for two reasons, both fixed before this round:');
  lines.push('');
  lines.push(
    '1. **Unsafe stop condition.** The script stopped paging as soon as an item older than the target row\'s `postedAt` appeared, assuming SocialCrawl returns reels in strict reverse-chronological order. It does not — a single out-of-order old item (e.g. a 2025-08-05 item mid-stream for `bielvalldo`) ended the walk early while real, reachable `included` rows were still unmatched. Fixed: the stop condition is now purely coverage-based (all target rows matched / cursor exhausted / hard page cap), never date-based.',
  );
  lines.push(
    '2. **Transient 504s aborted whole creators.** `bycarlosroberto` (0/7) and `henryjwade` (54/93 then died mid-page) both hit `FUNCTION_INVOCATION_TIMEOUT` on a single call and gave up. Fixed: every call now retries up to 3 times with backoff (2s, 6s, 15s) before being treated as a real failure.',
  );
  lines.push('');
  lines.push(
    'Also fixed: the credit-floor check now only trusts `credits_remaining` on responses where `cached === false` (a cached response reports `credits_remaining: 0`, a vendor bug, not a real balance). And this round only processed creators with `included` rows still missing `entry.socialcrawl` — already-covered rows from the first pass were never re-requested.',
  );
  lines.push('');

  let totalIncluded = 0;
  let totalWithShares = 0;
  for (const entries of allManifests.values()) {
    for (const e of entries) {
      if (e.status === 'included') {
        totalIncluded++;
        if (typeof e.socialcrawl?.shares === 'number') totalWithShares++;
      }
    }
  }
  lines.push(`**Final shares coverage after this round: ${totalWithShares} / ${totalIncluded}.**`);
  lines.push('');
  lines.push('Per-creator outcomes this round:');
  lines.push('');
  lines.push('| handle | included | already covered (from round 1) | target this run | matched this run | stop reason |');
  lines.push('|---|---:|---:|---:|---:|---|');
  for (const r of creatorReports) {
    lines.push(`| ${r.handle} | ${r.includedTotal} | ${r.alreadyCovered} | ${r.targetThisRun} | ${r.matchedThisRun}/${r.targetThisRun} | ${r.stopReason} |`);
  }
  lines.push('');
  lines.push(
    `This round's credits: starting ${fmtNum(budget.startingBalance)}, ending ${fmtNum(budget.currentBalance)}, consumed ${fmtNum(budget.totalConsumed)}.`,
  );
  lines.push(
    `Combined credits consumed across both rounds: ${fmtNum(ROUND1_CREDITS_CONSUMED)} (round 1) + ${fmtNum(budget.totalConsumed)} (this round) = ${fmtNum(ROUND1_CREDITS_CONSUMED + budget.totalConsumed)}.`,
  );
  lines.push('');

  return lines.join('\n');
}

// -----------------------------------------------------------------------
// Main
// -----------------------------------------------------------------------

async function main() {
  loadEnvLocal();
  requireEnv(['SOCIALCRAWL_API_KEY']);
  const apiKey = process.env.SOCIALCRAWL_API_KEY!;

  const rawRoot = path.join(process.cwd(), 'datasets', 'raw');
  const dirents = await fs.readdir(rawRoot, { withFileTypes: true });
  const creatorDirs = dirents.filter((d) => d.isDirectory()).map((d) => d.name).sort();

  const runTimestamp = new Date().toISOString();
  const fileTimestamp = runTimestamp.replace(/[:.]/g, '-'); // ':' is invalid in Windows filenames
  console.log('='.repeat(78));
  console.log(`Backing up all manifests before any write (manifest.json.scbak-${fileTimestamp})...`);
  const backups = await backupAllManifests(rawRoot, creatorDirs, fileTimestamp);
  for (const b of backups) console.log(`  ${b}`);
  console.log('='.repeat(78));

  const budget: Budget = { startingBalance: null, currentBalance: null, totalConsumed: 0, aborted: false };
  const creatorReports: CreatorReport[] = [];
  const failed: { handle: string; error: string }[] = [];

  for (const handle of creatorDirs) {
    if (budget.aborted) {
      console.log(`\n@${handle}: SKIPPED — run already aborted on credit floor.`);
      continue;
    }
    const dir = path.join(rawRoot, handle);
    console.log(`\n@${handle}: collecting shares...`);
    try {
      const report = await collectForCreator(apiKey, handle, dir, budget, runTimestamp);
      creatorReports.push(report);
      console.log(
        `@${handle}: ${report.matchedThisRun}/${report.targetThisRun} target rows matched this run (${report.alreadyCovered} already covered, ${report.includedTotal} included total), ${report.itemsFetched} items fetched over ${report.apiCalls} call(s), ${report.creditsUsed} credits used. Stop reason: ${report.stopReason}`,
      );
      if (report.aborted) {
        console.error(`@${handle}: RUN ABORTED — credit floor (${CREDIT_FLOOR}) reached. Balance: ${budget.currentBalance}.`);
      }
    } catch (e) {
      const message = (e as Error).message;
      console.error(`@${handle}: FAILED — ${message} — skipping this creator, manifest untouched.`);
      failed.push({ handle, error: message });
    }
  }

  // Reload every manifest fresh from disk for the audit, so it reflects
  // exactly what was written (including creators skipped/failed this run).
  const allManifests = new Map<string, Entry[]>();
  for (const handle of creatorDirs) {
    allManifests.set(handle, (await loadManifest(path.join(rawRoot, handle))) as Entry[]);
  }

  const baseReport = buildAuditReport(allManifests, creatorReports, budget, runTimestamp, backups);
  const retrySection = buildRetryRoundSection(creatorReports, budget, allManifests);
  const reportText = baseReport + '\n' + retrySection;
  console.log('\n' + reportText);

  const reportPath = path.join(rawRoot, '_shares-audit.md');
  await fs.writeFile(reportPath, reportText, 'utf8');
  console.log(`\nFull audit report written to ${reportPath}`);

  if (failed.length > 0) {
    console.log(`\n${failed.length} creator(s) failed and were skipped:`);
    for (const f of failed) console.log(`  @${f.handle}: ${f.error}`);
  }
  if (budget.aborted) {
    console.log(`\nRun ABORTED on credit floor. Balance: ${budget.currentBalance}.`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
