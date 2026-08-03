// Stage 2 — read the burned-in hook title out of each scraped video.
// Usage:
//   tsx scripts/extract-burned-in-titles.ts <handle>
//   tsx scripts/extract-burned-in-titles.ts <handle> --recheck 20
//
// One Claude vision pass per video. A second, offset-sampled pass runs only
// when the first pass's own evidence is weak, or when acting on it alone would
// discard a row (see scripts/lib/ocr-decisions.ts). Videos whose two passes
// conflict are quarantined for human review rather than guessed at.
//
// --recheck N re-reads N already-`included` rows and REPORTS differences
// without mutating the manifest. Used to sample-test rows produced by an
// earlier version of this script.

import fs from 'node:fs/promises';
import path from 'node:path';
import { loadEnvLocal, requireEnv } from './lib/load-env';
import { loadManifest, saveManifest, type ManifestEntry } from './lib/manifest';
import { frameCountFor, intervalFor, escalationOffsetFor } from './lib/frame-plan';
import {
  coverageOf,
  escalationReason,
  resolveOcrOutcome,
  titlesAgree,
  type OcrPass,
} from './lib/ocr-decisions';
import { parseRecheckValue, InvalidArgError } from './lib/cli-args';
import { ConsecutiveFailureTracker, CONSECUTIVE_FAILURE_LIMIT } from './lib/circuit-breaker';
import { ProviderCallFailure } from './lib/provider-call-failure';
import { extractFrames } from '../lib/media/frames';
import { transcribeBurnedInTitle } from '../lib/providers/anthropic/burned-in-title';

const MIN_USABLE_FRAMES = 2;

function parseArgs(argv: string[]) {
  const [handle, ...rest] = argv;
  if (!handle) {
    console.error('Usage: extract-burned-in-titles <handle> [--recheck N]');
    process.exit(1);
  }
  let recheck: number | null = null;
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === '--recheck') {
      try {
        recheck = parseRecheckValue(rest[++i]);
      } catch (e) {
        if (e instanceof InvalidArgError) {
          console.error(e.message);
          process.exit(1);
        }
        throw e;
      }
    }
  }
  return { handle, recheck };
}

async function readPass(
  videoBytes: Buffer,
  durationSec: number | null,
  offset: number | undefined,
): Promise<{ pass: OcrPass; costUsd: number; frames: number } | null> {
  const count = frameCountFor(durationSec);
  const interval = intervalFor(durationSec, count);
  const jpegs = await extractFrames(videoBytes, count, {
    intervalSec: interval,
    offsetSec: offset,
  });
  if (jpegs.length < MIN_USABLE_FRAMES) return null;
  let r: Awaited<ReturnType<typeof transcribeBurnedInTitle>>;
  try {
    r = await transcribeBurnedInTitle(jpegs);
  } catch (e) {
    // A billed HTTP 200 with no tool_use block throws here — the request was
    // charged but costUsd is never computed. Tag it so the caller can count
    // "may have been billed" failures separately instead of under-reporting
    // spend as if the call cost nothing.
    throw new ProviderCallFailure(
      `transcribeBurnedInTitle failed (may have been billed; cost not recorded): ${(e as Error).message}`,
    );
  }
  return {
    pass: {
      primaryTitle: r.primaryTitle,
      additionalTitles: r.additionalTitles,
      noTextFound: r.noTextFound,
      framesWithTitle: r.framesWithTitle,
      totalFrames: r.totalFrames,
      captionsPresent: r.captionsPresent,
      partialReveal: r.partialReveal,
      uncertain: r.uncertain,
    },
    costUsd: r.costUsd,
    frames: jpegs.length,
  };
}

async function main() {
  loadEnvLocal();
  requireEnv(['ANTHROPIC_API_KEY']);

  const { handle, recheck } = parseArgs(process.argv.slice(2));
  const dir = path.join(process.cwd(), 'datasets', 'raw', handle);
  const manifest = await loadManifest(dir);

  // Default: only untouched rows. --recheck: an already-processed sample,
  // chosen deterministically so the same 20 videos are picked every run.
  const pending = recheck
    ? manifest.filter((e) => e.status === 'included' && e.videoPath)
        .filter((_, i) => i % 4 === 0)
        .slice(0, recheck)
    : manifest.filter((e) => e.status === 'scraped' && e.videoPath);

  console.log(
    `${pending.length} videos to process for @${handle}` +
      (recheck ? ' (RECHECK — manifest will not be modified)' : ''),
  );

  let totalCost = 0;
  // Escalation ATTEMPTS — incremented whenever escalationReason() warrants a
  // second pass, regardless of whether that second pass succeeds. The old
  // code incremented only on success, making failed escalations invisible.
  let escalationAttempts = 0;
  let uncertainEscalations = 0;
  const escalationTriggerCounts = new Map<string, number>();
  // Rows that actually received a pass-1 verdict — the correct denominator
  // for the escalation rate. Rows that errored (never got a verdict) or were
  // too short (first === null, never entered escalationReason()) must not be
  // counted here, or the rate is diluted by rows that were never judged.
  let judgedRows = 0;
  let failed = 0;
  let possiblyBilledFailures = 0;
  const counts = new Map<string, number>();
  const review: Array<{ e: ManifestEntry; p1: OcrPass; p2: OcrPass | null; status: string }> = [];
  const recheckDiffs: string[] = [];
  const breaker = new ConsecutiveFailureTracker();

  // The per-video body. Early exits use `return` (not `continue`, as in the
  // original inline loop) specifically so the calling loop's try/catch can
  // tell success from failure uniformly — every early return here is a
  // legitimate outcome (too-short clip, unresolved escalation, recheck diff),
  // never a failure, and the circuit breaker below must reset on all of them.
  async function processEntry(entry: ManifestEntry): Promise<void> {
    const videoPath = path.join(dir, entry.videoPath!);
    const videoBytes = await fs.readFile(videoPath);

    const first = await readPass(videoBytes, entry.durationSec, undefined);
    if (!first) {
      if (!recheck) {
        entry.status = 'needs_review_too_short';
        await saveManifest(dir, manifest);
      }
      counts.set('needs_review_too_short', (counts.get('needs_review_too_short') ?? 0) + 1);
      console.log(`  ${entry.shortcode}: needs_review_too_short`);
      return;
    }
    totalCost += first.costUsd;
    judgedRows++;

    // null iff escalation is not warranted — this is the ONLY condition under
    // which it is safe to later call resolveOcrOutcome(first.pass, null).
    const escalation = escalationReason(first.pass);

    if (escalation !== null) {
      escalationAttempts++;
      escalationTriggerCounts.set(escalation, (escalationTriggerCounts.get(escalation) ?? 0) + 1);
      if (escalation === 'uncertain') uncertainEscalations++;
    }

    let second: Awaited<ReturnType<typeof readPass>> = null;
    if (escalation !== null) {
      const count = frameCountFor(entry.durationSec);
      const offset = escalationOffsetFor(intervalFor(entry.durationSec, count));
      second = await readPass(videoBytes, entry.durationSec, offset);
      if (second) {
        totalCost += second.costUsd;
      }
    }

    // DANGER — do not delete this guard. resolveOcrOutcome(pass, null) returns
    // `included` UNCONDITIONALLY when pass 2 is null: it trusts the caller to pass
    // null only when escalation was never warranted (escalation === null, above).
    // If escalation WAS warranted but pass 2 could not be extracted (offset sample
    // too short to yield MIN_USABLE_FRAMES), `second` is null here for a DIFFERENT
    // reason — calling resolveOcrOutcome in that case would launder an already-
    // untrustworthy pass-1 reading (e.g. a multi-title claim, which the project
    // requires be discarded) into `included`, with no error and no escalation
    // counted. So that case is handled here, before resolveOcrOutcome is ever
    // called, and resolveOcrOutcome below is only reachable with a null pass 2
    // when `escalation === null`.
    if (escalation !== null && !second) {
      const status = 'needs_review_too_short';
      counts.set(status, (counts.get(status) ?? 0) + 1);
      if (recheck) {
        recheckDiffs.push(
          `  ${entry.shortcode}\n    stored: ${JSON.stringify(entry.burnedInTitle)}\n    now:    pass 2 unreadable — escalation warranted [${escalation}] but could not be verified (${status})`,
        );
        console.log(`  ${entry.shortcode}: ${status} (DIFFERS — escalation warranted [${escalation}], pass 2 unreadable)`);
        return;
      }
      console.log(`  ${entry.shortcode}: ${status} (escalation warranted [${escalation}], pass 2 unreadable)`);
      // Persist pass 1's evidence even though this row is quarantined, not
      // accepted — an auditor reads manifest.json, not console scrollback, and
      // for a multi_title_claim escalation reason, additionalTitles here is the
      // entire explanation for the quarantine. burnedInTitle is evidence only:
      // every consumer of this manifest must gate on status === 'included'
      // before treating a title as usable (see report — this mirrors how
      // resolveOcrOutcome itself already sets burnedInTitle on non-included
      // statuses like excluded_multi_title and needs_review_single_frame).
      entry.status = status;
      entry.burnedInTitle = first.pass.primaryTitle ?? undefined;
      entry.additionalTitles = first.pass.additionalTitles;
      entry.titleFrameRatio = coverageOf(first.pass);
      entry.captionsPresent = first.pass.captionsPresent;
      entry.partialReveal = first.pass.partialReveal;
      entry.escalated = true; // an escalation was attempted — it just didn't complete
      entry.escalationReason = escalation;
      entry.ocrCostUsd = first.costUsd;
      entry.ocrPasses = [first.pass];
      review.push({ e: entry, p1: first.pass, p2: null, status });
      await saveManifest(dir, manifest);
      return;
    }

    const outcome = resolveOcrOutcome(first.pass, second?.pass ?? null);
    counts.set(outcome.status, (counts.get(outcome.status) ?? 0) + 1);

    if (recheck) {
      const same = titlesAgree(entry.burnedInTitle ?? null, outcome.burnedInTitle ?? null);
      if (!same || outcome.status !== 'included') {
        recheckDiffs.push(
          `  ${entry.shortcode}\n    stored: ${JSON.stringify(entry.burnedInTitle)}\n    now:    ${JSON.stringify(outcome.burnedInTitle)} (${outcome.status})`,
        );
      }
      console.log(`  ${entry.shortcode}: ${outcome.status}${same ? ' (match)' : ' (DIFFERS)'}`);
      return;
    }

    entry.status = outcome.status;
    entry.burnedInTitle = outcome.burnedInTitle;
    entry.additionalTitles = outcome.additionalTitles;
    entry.titleFrameRatio = outcome.titleFrameRatio;
    entry.partialReveal = outcome.partialReveal;
    entry.captionsPresent = outcome.captionsPresent;
    entry.escalated = outcome.escalated;
    entry.escalationReason = outcome.escalationReason;
    entry.ocrCostUsd = first.costUsd + (second?.costUsd ?? 0);
    entry.ocrPasses = second ? [first.pass, second.pass] : [first.pass];

    if (outcome.status.startsWith('needs_review')) {
      review.push({ e: entry, p1: first.pass, p2: second?.pass ?? null, status: outcome.status });
    }

    console.log(
      `  ${entry.shortcode}: ${outcome.status}` +
        (outcome.burnedInTitle ? ` — "${outcome.burnedInTitle}"` : '') +
        (outcome.escalated ? ` [escalated: ${outcome.escalationReason}]` : ''),
    );

    // Write after every video so a crash loses at most one video's work.
    await saveManifest(dir, manifest);
  }

  let breakerTripped = false;
  let processedCount = 0;
  for (const entry of pending) {
    processedCount++;
    try {
      await processEntry(entry);
      breaker.recordSuccess();
    } catch (e) {
      failed++;
      if (e instanceof ProviderCallFailure) possiblyBilledFailures++;
      console.error(`  ${entry.shortcode}: FAILED — ${(e as Error).message}`);
      if (breaker.recordFailure()) {
        breakerTripped = true;
        const remaining = pending.length - processedCount;
        console.error(
          `\n✖ ${CONSECUTIVE_FAILURE_LIMIT} consecutive failures — aborting rather than burning through ` +
            `the remaining ${remaining} video(s) blind. Investigate (schema rejection? model change? ` +
            `revoked key?) before re-running; already-processed rows above are saved.`,
        );
        break;
      }
    }
  }

  console.log('\n─── Report ───');
  for (const [status, n] of [...counts.entries()].sort()) console.log(`  ${status.padEnd(28)} ${n}`);
  console.log(`  ${'failed'.padEnd(28)} ${failed}` + (possiblyBilledFailures > 0
    ? ` (${possiblyBilledFailures} of which may have been billed by the provider — exact amount unknown and NOT included in cost below)`
    : ''));
  console.log(`  ${'cost'.padEnd(28)} $${totalCost.toFixed(4)}` + (possiblyBilledFailures > 0 ? ' (excludes possibly-billed failures above)' : ''));

  console.log('\n─── Escalation ───');
  console.log(
    `  sample size: ${judgedRows} row(s) judged this invocation (of ${pending.length} selected). This is a ` +
      `PER-INVOCATION figure — the script processes one creator per run, so this is NOT the whole-batch rate; ` +
      `do not compare it against the design's whole-batch acceptance range without aggregating across every ` +
      `creator's run first.`,
  );
  const overallRate = judgedRows > 0 ? (escalationAttempts / judgedRows) * 100 : 0;
  console.log(
    `  overall rate: ${overallRate.toFixed(0)}% (${escalationAttempts}/${judgedRows}) — a cost-planning figure ` +
      `only. It mixes deliberate confirm-before-discard triggers (no_title_claim, multi_title_claim) that fire ` +
      `in proportion to how much title-less/multi-title material is in the source, not model confidence, with ` +
      `genuine uncertainty. Do NOT read a high or low value here as "the prompt is under/over-confident".`,
  );
  console.log('  by trigger reason:');
  for (const [reason, n] of [...escalationTriggerCounts.entries()].sort()) {
    console.log(`    ${reason.padEnd(24)} ${n}`);
  }
  const uncertainRate = judgedRows > 0 ? (uncertainEscalations / judgedRows) * 100 : 0;
  console.log(
    `  uncertain rate: ${uncertainRate.toFixed(1)}% (${uncertainEscalations}/${judgedRows}) — the ONLY figure ` +
      `of the above that is diagnostic of model confidence (the model explicitly declined to commit).`,
  );

  if (breakerTripped) {
    console.log(`\n⚠ Run aborted early after ${CONSECUTIVE_FAILURE_LIMIT} consecutive failures — figures above cover only the rows processed before the abort.`);
    // Non-zero exit so this is visible to any calling script/CI and is not
    // mistaken for a clean, complete run.
    process.exitCode = 1;
  }

  if (review.length > 0) {
    console.log('\n─── Needs review ───');
    for (const r of review) {
      console.log(`\n  ${r.e.shortcode}  [${r.status}]  ${r.e.permalink}`);
      console.log(`    pass 1: ${JSON.stringify(r.p1.primaryTitle)} frames=${r.p1.framesWithTitle.length}/${r.p1.totalFrames} extra=${JSON.stringify(r.p1.additionalTitles)} uncertain=${r.p1.uncertain}`);
      if (r.p2) {
        console.log(`    pass 2: ${JSON.stringify(r.p2.primaryTitle)} frames=${r.p2.framesWithTitle.length}/${r.p2.totalFrames} extra=${JSON.stringify(r.p2.additionalTitles)} uncertain=${r.p2.uncertain}`);
      }
    }
  }

  if (recheck) {
    console.log(`\n─── Recheck: ${recheckDiffs.length}/${pending.length} differ ───`);
    for (const d of recheckDiffs) console.log(d);
    console.log(
      recheckDiffs.length >= 2
        ? '\n  ⚠ 2 or more differ — re-run the full set for this creator.'
        : '\n  ✓ Under the threshold — existing rows can stand.',
    );
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
