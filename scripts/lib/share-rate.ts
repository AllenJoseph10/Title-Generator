// share_rate = shares / views, the numerator of the corpus's primary metric.
//
// WHY THE DENOMINATOR IS CHOSEN RATHER THAN ASSUMED
//
// `views` on a manifest entry is the Apify-sourced figure, repaired in place on
// 2026-08-02 (see docs/findings/2026-08-02-view-metric-inconsistency.md).
// `socialcrawl.views` arrives in the SAME response as `socialcrawl.shares`.
//
// For the original corpus the two were fetched days apart at most and agree to
// under 0.1% (median ratio 1.0001 across 172 rows), so the choice was
// immaterial. It stops being immaterial for the under-performer backfill: those
// share counts were read on 2026-08-07 against view counts stored on
// 2026-08-02. Across those 137 rows the median drift is only 0.15%, but 5.1%
// grew more than 5% and one grew 2.6x — a video that took off in the gap.
//
// Dividing today's shares by a five-day-old view count inflates the rate for
// exactly those rows, and because performance_score is a PERCENTILE RANK a 2.6x
// inflation can carry a mid-pack row into the top decile. Preferring the
// same-call denominator makes numerator and denominator contemporaneous for
// every row, old and new. All 175 original rows carry socialcrawl.views too, so
// this is consistent across the corpus rather than a special case for the new
// rows.

export type ShareRateInput = {
  views?: number | null;
  socialcrawl?: { shares?: number | null; views?: number | null } | null;
};

export function shareRateOf(entry: ShareRateInput): number | null {
  const shares = entry.socialcrawl?.shares;
  // Absent means no reading, never zero: a zero would rank a genuinely
  // unmeasured video at the bottom and teach the model its title failed.
  if (typeof shares !== 'number') return null;

  const sameCall = entry.socialcrawl?.views;
  const denominator =
    typeof sameCall === 'number' && sameCall > 0
      ? sameCall
      : typeof entry.views === 'number' && entry.views > 0
        ? entry.views
        : null;
  if (denominator === null) return null;

  return shares / denominator;
}
