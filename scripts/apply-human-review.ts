// Apply human review decisions to quarantined (needs_review_*) rows.
//
// Usage:
//   npx tsx scripts/apply-human-review.ts            # dry run
//   npx tsx scripts/apply-human-review.ts --apply    # writes manifests
//
// WHY THIS IS A SCRIPT AND NOT A HAND EDIT
//
// The OCR pipeline deliberately refuses to guess: a title seen in one frame,
// or two passes that disagree, is quarantined rather than admitted. Clearing
// that quarantine is a human judgement, and the project's rule is that nothing
// enters the corpus without its reason recorded alongside it. Eight rows were
// promoted this way on 2026-08-02 and each carries a `humanReview` string. This
// keeps that audit trail and makes the decisions re-runnable and reviewable in
// a diff rather than buried in a terminal session.
//
// REVIEW OF 2026-08-08 — the 27 rows quarantined by the under-performer
// backfill. The reviewer applied a content rule beyond "is there a title":
// a title naming a SPECIFIC PLACE or carrying an over-specific NUMBER is
// rejected, because the corpus feeds few-shot examples and a title anchored to
// a location the uploaded video does not show teaches the generator to invent
// one. That rule accounts for most of the rejections below.
//
// NOTE ON ROW 8 (DZS-3HXRmJO, "6 ways to wear your suit"): the reviewer asked
// for the number to be removed. `burned_in_title` is verbatim by design and
// `scripts/lib/title-template.ts` already emits "{N} ways to wear your suit"
// into the `title_template` column, which is where generalisation belongs. The
// stored title is therefore left exact and the number is abstracted downstream.

import path from 'node:path';
import fs from 'node:fs/promises';
import { loadManifest, saveManifest, type ManifestEntry } from './lib/manifest';

const REVIEW_DATE = '2026-08-08';

type Decision =
  | { verdict: 'promote'; reason: string }
  | { verdict: 'exclude'; status: string; reason: string };

// Keyed by shortcode. Row numbers match the review listing.
const DECISIONS: Record<string, Decision> = {
  // 1
  DVy5pNYDMDC: { verdict: 'exclude', status: 'excluded_no_title', reason: 'no burned-in title present' },
  // 2
  DaTNb2ft277: { verdict: 'exclude', status: 'excluded_no_title', reason: 'subtitles in quotation marks, not a burned-in title' },
  // 3
  DZ7dZ2JtA78: { verdict: 'exclude', status: 'excluded_human_review', reason: 'title names a specific place (Ibiza)' },
  // 4
  'DY-JbQcNAF6': { verdict: 'exclude', status: 'excluded_no_title', reason: 'not a title' },
  // 5
  DWoxCfmjVEs: { verdict: 'exclude', status: 'excluded_no_title', reason: 'not a title' },
  // 6
  'DRCEk-sDIf8': { verdict: 'promote', reason: 'valid title, consistent with the events in the visual description' },
  // 7
  DY4sZdOi2GF: { verdict: 'exclude', status: 'excluded_human_review', reason: 'title names a specific place (eurosummer)' },
  // 8
  'DZS-3HXRmJO': { verdict: 'promote', reason: 'valid title; the leading number is generalised to {N} by title_template, stored title left verbatim' },
  // 9
  DbQlUpYNJVy: { verdict: 'exclude', status: 'excluded_human_review', reason: 'title names a specific place (Dolomites, Italy)' },
  // 10
  DYceO3SNjSc: { verdict: 'promote', reason: 'valid title' },
  // 11
  DYCnxedNaHI: { verdict: 'promote', reason: 'valid title' },
  // 12
  DXZano8PI_R: { verdict: 'promote', reason: 'valid title' },
  // 13
  DVL9JJ9DIUk: { verdict: 'exclude', status: 'excluded_human_review', reason: 'title names a specific place (Arctic Circle, Sweden)' },
  // 14
  DRNArZ4jLuC: { verdict: 'promote', reason: 'valid title' },
  // 15
  DQo6cLpDLE1: { verdict: 'exclude', status: 'excluded_human_review', reason: 'rejected in human review' },
  // 16
  'DSnKT-VDSJw': { verdict: 'exclude', status: 'excluded_human_review', reason: 'rejected in human review' },
  // 17
  DUGrR6xCFJs: { verdict: 'exclude', status: 'excluded_human_review', reason: 'rejected in human review' },
  // 18
  DVJWKPREfLI: { verdict: 'exclude', status: 'excluded_human_review', reason: 'title names a specific place (NYC)' },
  // 19
  DYUjNG0s_GH: { verdict: 'promote', reason: 'valid title' },
  // 20
  DUlVOiwDNRW: { verdict: 'exclude', status: 'excluded_human_review', reason: 'rejected in human review' },
  // 21
  'DSk1HOHDGmD': { verdict: 'promote', reason: 'valid title' },
  // 22
  DYJmDc1inxB: { verdict: 'exclude', status: 'excluded_human_review', reason: 'title names a specific place (Amsterdam)' },
  // 23
  DZ0NJAptOV2: { verdict: 'exclude', status: 'excluded_human_review', reason: 'rejected in human review' },
  // 24-27 are deliberately absent: no verdict was given for them, so they stay
  // in needs_review rather than defaulting either way.
};

// Title source for a promoted row. Quarantined rows never had burnedInTitle
// written — the evidence lives in ocrPasses — so it is recovered here, with
// the source recorded in the audit string.
function titleFor(e: ManifestEntry): { title: string; source: string } | null {
  const passes = (e.ocrPasses ?? []) as Array<{ primaryTitle?: string | null } | null>;
  const p1 = passes[0]?.primaryTitle;
  const p2 = passes[1]?.primaryTitle;
  if (typeof p1 === 'string' && p1.length > 0) {
    return { title: p1, source: typeof p2 === 'string' && p2 === p1 ? 'both passes agree' : 'pass 1' };
  }
  if (typeof p2 === 'string' && p2.length > 0) return { title: p2, source: 'pass 2 only' };
  return null;
}

async function main() {
  const apply = process.argv.includes('--apply');
  const rawRoot = path.join(process.cwd(), 'datasets', 'raw');
  const dirs = (await fs.readdir(rawRoot, { withFileTypes: true }))
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();

  const seen = new Set<string>();
  let promoted = 0;
  let excluded = 0;
  const problems: string[] = [];

  for (const handle of dirs) {
    const dir = path.join(rawRoot, handle);
    const manifest = await loadManifest(dir);
    let touched = 0;

    for (const e of manifest) {
      const d = DECISIONS[e.shortcode];
      if (!d) continue;
      seen.add(e.shortcode);

      // Fail loudly rather than silently re-processing a row whose state moved
      // since the review was written.
      if (!/^needs_review/.test(e.status)) {
        problems.push(`${handle}/${e.shortcode}: expected needs_review_*, found '${e.status}' — skipped`);
        continue;
      }

      if (d.verdict === 'promote') {
        const t = titleFor(e);
        if (!t) {
          problems.push(`${handle}/${e.shortcode}: promote requested but neither pass produced a title — skipped`);
          continue;
        }
        e.burnedInTitle = t.title;
        e.status = 'included';
        e.humanReview = `kept by human review ${REVIEW_DATE}: ${d.reason}. Title source: ${t.source}.`;
        promoted++;
        touched++;
        console.log(`  PROMOTE  ${handle}/${e.shortcode}  ${JSON.stringify(t.title)}  [${t.source}]`);
      } else {
        e.status = d.status;
        e.humanReview = `excluded by human review ${REVIEW_DATE}: ${d.reason}.`;
        excluded++;
        touched++;
        console.log(`  EXCLUDE  ${handle}/${e.shortcode}  -> ${d.status}  (${d.reason})`);
      }
    }

    if (apply && touched > 0) await saveManifest(dir, manifest);
  }

  const missing = Object.keys(DECISIONS).filter((s) => !seen.has(s));
  console.log(`\npromoted ${promoted}, excluded ${excluded}, decisions ${Object.keys(DECISIONS).length}`);
  if (missing.length) console.log(`!! shortcodes in DECISIONS not found in any manifest: ${missing.join(', ')}`);
  if (problems.length) {
    console.log('\nproblems:');
    problems.forEach((p) => console.log('  ' + p));
  }
  console.log(apply ? '\napplied — manifests written.' : '\ndry run: nothing written. Re-run with --apply.');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
