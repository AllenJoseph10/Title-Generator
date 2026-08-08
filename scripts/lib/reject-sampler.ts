// Selection and stratified sampling for the under-performer backfill.
//
// WHY THIS EXISTS
//
// refresh-media-urls.ts was built to rescue rows that the *corrected* view
// metrics promoted ABOVE the 3x outlier gate. Its `isCandidate` therefore
// hardcodes `outlierMultiplier >= 3`, which is the exact opposite of what a
// backfill of normal-performing videos needs. Rather than overload that
// predicate with a mode flag, the selection rules live here as pure functions.
//
// TWO RULES DO THE REAL WORK, and neither is arbitrary:
//
// 1. A VIEWS FLOOR, NOT A "PICK THE WORST" RULE. Ground truth is
//    share_rate = shares/views. At 2,000 views a representative 0.004 share
//    rate carries ~35% relative standard error; at 20,000 it is ~11%. Scraping
//    the deepest flops would buy rows whose measured performance is mostly
//    noise, and the eval would report that as the prior getting worse. The
//    floor is a PRECISION requirement.
//
// 2. NO SELECTION ON THE MULTIPLIER BAND WITHIN THE FLOOR. Instagram's initial
//    reach is close to a lottery, so `views` is a chance-heavy variable, and
//    filtering the sample on it while measuring shares-per-view would select
//    on the denominator of the outcome. The floor bounds precision; what lands
//    above it is taken as it comes.
//
// Per-creator caps exist for a different reason: henryjwade is already 93 of
// the 175 corpus rows, and an uncapped draw would push one creator's audience
// dynamics past 60% of the ground truth.

import { mulberry32 } from './eval-split';

export type RejectCandidate = {
  handle: string;
  shortcode: string;
  views: number | null;
  durationSec: number | null;
  outlierMultiplier?: number;
  status: string;
};

export type SelectionCriteria = {
  statuses: string[];
  minViews: number;
  // Exclusive. Rows at or above this already clear the outlier gate and are
  // the job of `refresh-media-urls.ts` in its original mode.
  maxMultiplier: number;
  maxDurationSec: number;
  total: number;
  perCreatorCap: number;
  capOverrides?: Record<string, number>;
  seed: number;
};

export function isEligible(entry: RejectCandidate, criteria: SelectionCriteria): boolean {
  if (!criteria.statuses.includes(entry.status)) return false;

  // A null denominator cannot produce a share rate, so the row could never be
  // scored — the one thing this backfill exists to provide.
  if (typeof entry.views !== 'number' || entry.views < criteria.minViews) return false;

  if (typeof entry.outlierMultiplier !== 'number' || entry.outlierMultiplier >= criteria.maxMultiplier) {
    return false;
  }

  // An unknown duration is not grounds for exclusion; probeVideo enforces the
  // real 60s cap once the file is on disk. Matches refresh-media-urls.ts.
  if (entry.durationSec !== null && entry.durationSec > criteria.maxDurationSec) return false;

  return true;
}

// Fisher-Yates against the supplied PRNG. Returns a new array; the caller's
// pool is never reordered.
function shuffled<T>(xs: readonly T[], rand: () => number): T[] {
  const out = [...xs];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

// Filter to eligible rows, then deal `total` of them round-robin across
// creators so no single handle dominates the draw.
//
// Round-robin rather than proportional allocation because it self-corrects:
// when a creator's queue runs dry its remaining slots flow to creators that
// still have supply, instead of silently under-filling the run.
export function selectRejects(
  candidates: readonly RejectCandidate[],
  criteria: SelectionCriteria,
): RejectCandidate[] {
  const eligible = candidates.filter((e) => isEligible(e, criteria));

  const byHandle = new Map<string, RejectCandidate[]>();
  for (const e of eligible) {
    const list = byHandle.get(e.handle);
    if (list) list.push(e);
    else byHandle.set(e.handle, [e]);
  }

  // Sorted so the PRNG draw sequence — and therefore the whole selection — is
  // a function of the seed alone, not of manifest read order.
  const handles = [...byHandle.keys()].sort();
  const rand = mulberry32(criteria.seed);

  const queues = handles.map((h) => {
    const cap = criteria.capOverrides?.[h] ?? criteria.perCreatorCap;
    return shuffled(byHandle.get(h)!, rand).slice(0, Math.max(0, cap));
  });

  const out: RejectCandidate[] = [];
  let dealt = true;
  while (out.length < criteria.total && dealt) {
    dealt = false;
    for (const q of queues) {
      if (out.length >= criteria.total) break;
      const next = q.shift();
      if (next) {
        out.push(next);
        dealt = true;
      }
    }
  }
  return out;
}
