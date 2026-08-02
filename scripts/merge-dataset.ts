// Stage 6 — merge every creator's manifest into the single dataset CSV.
// Usage: tsx scripts/merge-dataset.ts
//
// Only `included` rows are emitted. Everything else stays in the manifests
// with its reason, so nothing is lost and any exclusion can be re-audited.

import fs from 'node:fs/promises';
import path from 'node:path';
import { loadManifest } from './lib/manifest';
import { csvRow } from './lib/csv';
import { templatiseTitle } from './lib/title-template';

const HEADER = [
  'video_id', 'date_posted', 'platform', 'creator_handle', 'video_url',
  'burned_in_title', 'caption', 'views', 'likes', 'comments', 'shares',
  'saves', 'duration_sec', 'niche', 'hook_family', 'notes', 'visual_description',
  'title_template',
  // Performance metrics. Decision recorded in
  // docs/findings/2026-08-02-performance-metric-decision.md
  'share_rate', 'performance_score', 'view_outlier', 'view_outlier_score',
];

const NICHE = 'luxury-menswear';

// Percentile rank of each value within the corpus, as a 0-1 score.
// Percentile rather than the raw ratio because both underlying metrics are
// heavily skewed (view outlier spans 692x p05-p95), and `corpus_titles`
// expects a bounded 0-1 score. Ties share the lower rank.
function percentileScores(values: (number | null)[]): (number | null)[] {
  const present = values.filter((v): v is number => v !== null && Number.isFinite(v));
  const sorted = [...present].sort((a, b) => a - b);
  const n = sorted.length;
  return values.map((v) => {
    if (v === null || !Number.isFinite(v)) return null;
    if (n <= 1) return 0.5;
    let below = 0;
    while (below < n && sorted[below] < v) below++;
    return Number((below / (n - 1)).toFixed(4));
  });
}

function median(nums: number[]): number {
  if (!nums.length) return 0;
  const s = [...nums].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? (s[m - 1] + s[m]) / 2 : s[m];
}
const OUT = path.join(process.cwd(), 'datasets', 'william-wade-titles.csv');

async function main() {
  const rawRoot = path.join(process.cwd(), 'datasets', 'raw');
  const handles = (await fs.readdir(rawRoot, { withFileTypes: true }))
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();

  // Pass 1 — collect every row, plus the raw metrics, because percentiles
  // cannot be computed until the whole corpus is known.
  type Row = { handle: string; e: Awaited<ReturnType<typeof loadManifest>>[number]; shareRate: number | null; viewOutlier: number | null };
  const collected: Row[] = [];

  for (const handle of handles) {
    const entries = await loadManifest(path.join(rawRoot, handle));
    // Baseline is the median across ALL of this creator's scraped videos, not
    // just the included ones — a 4-10 row denominator would be far noisier.
    const baseline = median(
      entries.map((x) => x.views).filter((v): v is number => typeof v === 'number' && v > 0),
    );
    const included = entries.filter((e) => e.status === 'included' && e.burnedInTitle);
    for (const e of included) {
      const shares = e.socialcrawl?.shares;
      collected.push({
        handle,
        e,
        shareRate: typeof shares === 'number' && e.views ? shares / e.views : null,
        viewOutlier: e.views && baseline > 0 ? e.views / baseline : null,
      });
    }
    console.log(`  ${handle.padEnd(20)} ${included.length} rows`);
  }

  const shareScores = percentileScores(collected.map((r) => r.shareRate));
  const outlierScores = percentileScores(collected.map((r) => r.viewOutlier));

  // Pass 2 — emit.
  const lines: string[] = [];
  let id = 0;
  let missingDescription = 0;
  let missingScore = 0;

  {
    for (const [i, { handle, e, shareRate, viewOutlier }] of collected.entries()) {
      id++;
      if (!e.visualDescription) missingDescription++;
      if (shareScores[i] === null) missingScore++;
      lines.push(csvRow([
        id,
        e.postedAt,
        'reels',
        handle,
        e.permalink,
        e.burnedInTitle,
        e.caption,
        e.views,
        e.likes,
        e.comments,
        // shares — from SocialCrawl; Apify exposes no share field at all.
        // Empty means we have no reading, NOT zero: three rows legitimately
        // returned null on videos with 66-14,847 views, i.e. genuinely unshared.
        e.socialcrawl?.shares ?? '',
        // saves — verified unobtainable from every source tested (SocialCrawl
        // returns null on every reel, including its premium endpoint), and the
        // feature is now hidden on Instagram itself.
        '',
        e.durationSec,
        NICHE,
        '', // hook_family — assigned by the importer from lib/hooks/taxonomy.ts
        e.partialReveal ? 'partial_reveal' : '',
        e.visualDescription,
        templatiseTitle(e.burnedInTitle ?? ''),
        shareRate === null ? '' : shareRate.toFixed(6),
        shareScores[i] ?? '',
        viewOutlier === null ? '' : viewOutlier.toFixed(3),
        outlierScores[i] ?? '',
      ]));
    }
  }

  // UTF-8 BOM so Excel renders emoji and smart quotes correctly on open.
  await fs.writeFile(OUT, '﻿' + [csvRow(HEADER), ...lines].join('\n') + '\n');

  console.log(`\nWrote ${lines.length} rows to ${OUT}`);
  if (missingDescription > 0) {
    console.log(`⚠ ${missingDescription} rows have no visual_description — run describe:videos first.`);
  }
  if (missingScore > 0) {
    console.log(`⚠ ${missingScore} rows have no performance_score (no share count) — the importer must treat these as unscored, NOT as zero.`);
  }
  if (lines.length < 200) {
    console.log(`⚠ ${lines.length} rows is below the 200-row floor for the prior to be meaningful.`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
