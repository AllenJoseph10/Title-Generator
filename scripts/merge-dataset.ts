// Stage 6 — merge every creator's manifest into the single dataset CSV.
// Usage: tsx scripts/merge-dataset.ts
//
// Only `included` rows are emitted. Everything else stays in the manifests
// with its reason, so nothing is lost and any exclusion can be re-audited.

import fs from 'node:fs/promises';
import path from 'node:path';
import { loadManifest } from './lib/manifest';
import { csvRow } from './lib/csv';

const HEADER = [
  'video_id', 'date_posted', 'platform', 'creator_handle', 'video_url',
  'burned_in_title', 'caption', 'views', 'likes', 'comments', 'shares',
  'saves', 'duration_sec', 'niche', 'hook_family', 'notes', 'visual_description',
];

const NICHE = 'luxury-menswear';
const OUT = path.join(process.cwd(), 'datasets', 'william-wade-titles.csv');

async function main() {
  const rawRoot = path.join(process.cwd(), 'datasets', 'raw');
  const handles = (await fs.readdir(rawRoot, { withFileTypes: true }))
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();

  const lines: string[] = [];
  let id = 0;
  let missingDescription = 0;

  for (const handle of handles) {
    const entries = await loadManifest(path.join(rawRoot, handle));
    const included = entries.filter((e) => e.status === 'included' && e.burnedInTitle);
    for (const e of included) {
      id++;
      if (!e.visualDescription) missingDescription++;
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
        '', // shares — private analytics, unscrapable
        '', // saves  — private analytics, unscrapable
        e.durationSec,
        NICHE,
        '', // hook_family — assigned by the importer from lib/hooks/taxonomy.ts
        e.partialReveal ? 'partial_reveal' : '',
        e.visualDescription,
      ]));
    }
    console.log(`  ${handle.padEnd(20)} ${included.length} rows`);
  }

  // UTF-8 BOM so Excel renders emoji and smart quotes correctly on open.
  await fs.writeFile(OUT, '﻿' + [csvRow(HEADER), ...lines].join('\n') + '\n');

  console.log(`\nWrote ${lines.length} rows to ${OUT}`);
  if (missingDescription > 0) {
    console.log(`⚠ ${missingDescription} rows have no visual_description — run describe:videos first.`);
  }
  if (lines.length < 200) {
    console.log(`⚠ ${lines.length} rows is below the 200-row floor for the prior to be meaningful.`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
