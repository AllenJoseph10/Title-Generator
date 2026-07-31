import fs from 'node:fs/promises';
import path from 'node:path';

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
};

export function manifestPath(dir: string): string {
  return path.join(dir, 'manifest.json');
}

export async function loadManifest(dir: string): Promise<ManifestEntry[]> {
  try {
    return JSON.parse(await fs.readFile(manifestPath(dir), 'utf8')) as ManifestEntry[];
  } catch {
    return [];
  }
}

export async function saveManifest(dir: string, entries: ManifestEntry[]): Promise<void> {
  await fs.writeFile(manifestPath(dir), JSON.stringify(entries, null, 2));
}
