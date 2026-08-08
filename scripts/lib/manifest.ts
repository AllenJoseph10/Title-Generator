import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

// One record per post evaluated, written by every stage. Nothing is ever
// deleted: excluded posts keep their reason so any decision can be re-audited
// without re-running the model.
export type ManifestEntry = {
  // Stage 1 — scrape
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
  outlierMultiplier?: number;
  viewsPerDay?: number;
  // Set by scripts/refresh-media-urls.ts --admit when a row that was excluded
  // on the pre-repair view numbers is re-admitted to the pipeline. Records the
  // status it was rescued from, so a re-admitted row is never indistinguishable
  // from one that passed the gate first time.
  readmittedFrom?: string;
  // Set by scripts/apply-human-review.ts when a person clears (or confirms) a
  // needs_review_* quarantine. The OCR stages never write it — a row carrying
  // this field entered or left the corpus on human judgement, not on model
  // agreement, and the string records who decided what and why.
  humanReview?: string;
  rank?: 'top' | 'bottom';
  duplicateOfHandle?: string;

  // Stage 2 — OCR
  burnedInTitle?: string;
  additionalTitles?: string[];
  titleFrameRatio?: number;
  partialReveal?: boolean;
  captionsPresent?: boolean;
  escalated?: boolean;
  escalationReason?: string;
  ocrCostUsd?: number;
  ocrPasses?: unknown[]; // raw provider responses, for audit

  // Stage 2b — describe
  visualDescription?: string;
  descriptionFields?: {
    scene: string;
    subject: string;
    setting: string;
    vibe: string[];
    visualHook: string;
  };
  describeCostUsd?: number;
  describeError?: string;

  // Stage 3 — metrics
  // Set by scripts/refresh-metrics.ts when views/likes/comments were re-pulled
  // from Apify (see docs/findings/2026-08-02-view-metric-inconsistency.md).
  metricsRefreshedAt?: string;
  // Independent metrics from SocialCrawl, kept in their own object so the
  // Apify-sourced top-level views/likes/comments are never overwritten — the
  // cross-source audit is only possible while both readings coexist.
  // `shares` is the reason this exists: Apify exposes no share field at all.
  socialcrawl?: {
    views: number | null;
    likes: number | null;
    comments: number | null;
    shares: number | null;
    engagementRate: number | null;
    estimatedReach: number | null;
    fetchedAt: string;
  };
};

export function manifestPath(dir: string): string {
  return path.join(dir, 'manifest.json');
}

// A genuinely absent manifest (first run for a creator) is the only case that
// means "empty". Anything else — malformed JSON from a truncated write,
// permission errors, an unreadable file — must throw with the path attached.
// Silently returning [] here is exactly how a crash mid-write turns into "0
// videos to process" and a batch that looks clean but lost a creator's record.
export async function loadManifest(dir: string): Promise<ManifestEntry[]> {
  const file = manifestPath(dir);
  let text: string;
  try {
    text = await fs.readFile(file, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw new Error(`loadManifest: could not read ${file}: ${(e as Error).message}`);
  }
  try {
    return JSON.parse(text) as ManifestEntry[];
  } catch (e) {
    throw new Error(
      `loadManifest: ${file} exists but is not valid JSON — refusing to treat it as an ` +
        `empty manifest. This usually means a previous run crashed mid-write. Check for a ` +
        `leftover ${path.basename(file)}.<pid>-<uuid>.tmp next to it (may hold the last good ` +
        `write) or restore from backup. (${(e as Error).message})`,
    );
  }
}

export async function saveManifest(dir: string, entries: ManifestEntry[]): Promise<void> {
  const file = manifestPath(dir);
  // Serialise to a temp file in the SAME directory — so the rename below is
  // same-volume and therefore atomic on both Windows and POSIX — then rename
  // over the target. The per-call-unique suffix (pid + uuid) means a stale
  // .tmp left behind by a previous crash can never collide with, or be
  // clobbered by, this call. It also means an orphaned .tmp is harmless: only
  // manifest.json itself is ever read, so a leftover temp file just sits
  // there inert (and gets synced by OneDrive like any other file, but nothing
  // in this codebase treats its presence or contents as meaningful).
  const tmp = `${file}.${process.pid}-${randomUUID()}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(entries, null, 2));
  await fs.rename(tmp, file);
}
