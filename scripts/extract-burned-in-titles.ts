// Stage 2 — OCR the burned-in hook title out of each scraped video.
// Usage: tsx scripts/extract-burned-in-titles.ts <handle> [--frames N] [--crop 0.8]
//
// Reads datasets/raw/<handle>/manifest.json and asks Claude to identify the
// burned-in hook title from full, uncropped frames sampled across the whole
// clip. Titles can sit anywhere from the top to the middle of frame, so
// isolation relies on the model distinguishing a static hook-title overlay
// from auto-generated speech captions and incidental scene text by BEHAVIOR
// (does the text persist unchanged across frames, or change every frame like
// transcribed speech) rather than by position — see lib/prompts/burned-in-title.ts.
// Posts with no burned-in title, or with more than one distinct hook title
// across the clip, are excluded from the CSV but kept (with reason) in the
// manifest for audit/spot-check.

import fs from 'node:fs/promises';
import path from 'node:path';
import { loadEnvLocal, requireEnv } from './lib/load-env';
import { extractFrames } from '../lib/media/frames';
import { transcribeBurnedInTitle } from '../lib/providers/anthropic/burned-in-title';

// No crop by default — titles can be top or mid-frame, so geometry can't
// reliably isolate them (see header comment). --crop is available as a manual
// override if a specific creator's captions/UI reliably sit in one zone.
const DEFAULT_CROP_TOP_FRACTION: number | undefined = undefined;
// extractFrames samples at 1 frame / 2s starting from t=0, so frame count must
// scale with clip length or a title change late in a longer clip is never seen.
const SECONDS_PER_FRAME = 2;
const MIN_FRAMES = 4;
const MAX_FRAMES = 30; // covers the full 60s duration cap

type ManifestEntry = {
  shortcode: string;
  permalink: string;
  caption: string;
  views: number | null;
  likes: number | null;
  comments: number | null;
  postedAt: string | null;
  durationSec: number | null;
  videoUrl: string | null;
  status: string;
  videoPath?: string;
  burnedInTitle?: string;
  additionalTitles?: string[];
  ocrCostUsd?: number;
};

function parseArgs(argv: string[]) {
  const [handle, ...rest] = argv;
  if (!handle) {
    console.error('Usage: extract-burned-in-titles <handle> [--frames N] [--crop 0.5]');
    process.exit(1);
  }
  let frames: number | null = null; // null = auto-scale per video to cover its full duration
  let crop = DEFAULT_CROP_TOP_FRACTION;
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === '--frames') frames = parseInt(rest[++i], 10);
    else if (rest[i] === '--crop') crop = parseFloat(rest[++i]);
  }
  return { handle, frames, crop };
}

// Frame count must cover the whole clip, not just its first ~16s, or a title
// change late in a longer video is invisible to the OCR pass.
function frameCountFor(durationSec: number | null, override: number | null): number {
  if (override !== null) return override;
  const seconds = durationSec ?? 16;
  return Math.min(MAX_FRAMES, Math.max(MIN_FRAMES, Math.ceil(seconds / SECONDS_PER_FRAME)));
}

function csvEscape(s: string): string {
  return `"${s.replace(/"/g, '""')}"`;
}

async function emitCsv(dir: string, handle: string, manifest: ManifestEntry[]) {
  const rows = manifest.filter((e) => e.status === 'included');
  const header =
    'video_id,date_posted,platform,creator_handle,video_url,burned_in_title,caption,views,likes,comments,shares,saves,duration_sec,niche,hook_family,notes';
  const lines = rows.map((r) =>
    [
      '', // video_id — assigned when per-creator CSVs are merged into the final dataset
      r.postedAt ?? '',
      'reels',
      handle,
      r.permalink,
      csvEscape(r.burnedInTitle ?? ''),
      csvEscape(r.caption ?? ''),
      r.views ?? '',
      r.likes ?? '',
      r.comments ?? '',
      '', // shares — private analytics, unscrapable
      '', // saves — private analytics, unscrapable
      r.durationSec ?? '',
      'luxury-menswear',
      '', // hook_family — assigned by the importer
      '',
    ].join(','),
  );
  const csvPath = path.join(dir, `${handle}.csv`);
  // UTF-8 BOM: without it, Excel ignores the system locale and mangles any
  // multi-byte character (emoji, smart quotes) on open — the data itself is
  // correct either way, this is purely so Excel renders it correctly.
  const BOM = '\uFEFF';
  await fs.writeFile(csvPath, BOM + [header, ...lines].join('\n') + '\n');
  console.log(`Wrote ${rows.length} included rows to ${csvPath}`);
}

async function main() {
  loadEnvLocal();
  requireEnv(['ANTHROPIC_API_KEY']);

  const { handle, frames: frameOverride, crop } = parseArgs(process.argv.slice(2));
  const dir = path.join(process.cwd(), 'datasets', 'raw', handle);
  const manifestPath = path.join(dir, 'manifest.json');
  const manifest: ManifestEntry[] = JSON.parse(await fs.readFile(manifestPath, 'utf8'));

  const pending = manifest.filter((e) => e.status === 'scraped' && e.videoPath);
  console.log(
    `${pending.length} videos to OCR (of ${manifest.length} total manifest entries). frames=${frameOverride ?? 'auto (scaled to duration)'} cropTopFraction=${crop}`,
  );

  let totalCost = 0;
  let included = 0;
  let noTitle = 0;
  let multiTitle = 0;
  let failed = 0;

  for (const entry of pending) {
    const videoPath = path.join(dir, entry.videoPath!);
    try {
      const videoBytes = await fs.readFile(videoPath);
      const frameCount = frameCountFor(entry.durationSec, frameOverride);
      const jpegs = await extractFrames(videoBytes, frameCount, { cropTopFraction: crop });
      const result = await transcribeBurnedInTitle(jpegs);
      totalCost += result.costUsd;
      entry.ocrCostUsd = result.costUsd;

      if (result.noTextFound || !result.primaryTitle) {
        entry.status = 'excluded_no_title';
        noTitle++;
      } else if (result.additionalTitles.length > 0) {
        entry.status = 'excluded_multi_title';
        entry.burnedInTitle = result.primaryTitle;
        entry.additionalTitles = result.additionalTitles;
        multiTitle++;
      } else {
        entry.status = 'included';
        entry.burnedInTitle = result.primaryTitle;
        included++;
      }
      console.log(`  ${entry.shortcode}: ${entry.status}${entry.burnedInTitle ? ` — "${entry.burnedInTitle}"` : ''}`);
    } catch (e) {
      console.error(`  ${entry.shortcode}: FAILED — ${(e as Error).message}`);
      failed++;
    }
    // Write back after every video so a crash mid-run doesn't lose progress.
    await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2));
  }

  console.log(
    `\nDone. included=${included} excluded_no_title=${noTitle} excluded_multi_title=${multiTitle} failed=${failed}`,
  );
  console.log(`Claude vision cost this run: $${totalCost.toFixed(4)}`);

  await emitCsv(dir, handle, manifest);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
