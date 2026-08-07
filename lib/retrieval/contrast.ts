// Split retrieved corpus rows into "patterns to mimic" and "patterns that did
// not land".
//
// WHY THIS EXISTS
//
// Until the under-performer backfill, every row in corpus_titles had cleared a
// >=3x outlier gate, so the prompt could safely head them "examples" and tell
// the model to copy the patterns. Once normal-performing videos are imported
// that is no longer true, and the prompt would be handing the model losers
// under a banner telling it to mimic them.
//
// Two competing risks, which is why this is a partition and not a filter:
//
//   Dropping the weak rows entirely is the safe move, but it throws away the
//   only signal in the corpus about what FAILS. The model then has no
//   reference for a bad line — every example it has ever seen worked.
//
//   Showing them unmarked is worse: in-context imitation is a strong effect
//   and label-following is a weak one, so a weak line sitting in a list headed
//   "mimic these patterns" mostly just gets mimicked.
//
// So they are separated into their own clearly-headed block, capped, and never
// allowed to crowd out the positives. This is the mechanism by which the
// backfill can affect generation at all — the model does not "learn" from the
// corpus, it only ever sees what the prompt puts in front of it.

// Percentile at or below which a row is presented as something that did not
// land. 0.35 rather than 0.5 so the contrast set is genuinely weak rather than
// merely below-average — a row at the 45th percentile is not a cautionary tale.
export const CONTRAST_MAX_SCORE = 0.35;

// Ceiling on the contrast block. The prompt's job is still to produce good
// titles; a wall of failures displaces the patterns worth copying.
export const MAX_CONTRAST = 3;

export type Partitioned<T> = { mimic: T[]; contrast: T[] };

export function partitionByPerformance<T extends { performanceScore: number | null }>(
  examples: readonly T[],
  opts: { contrastMaxScore?: number; maxContrast?: number } = {},
): Partitioned<T> {
  const maxScore = opts.contrastMaxScore ?? CONTRAST_MAX_SCORE;
  const cap = opts.maxContrast ?? MAX_CONTRAST;

  // A null score is unmeasured, not failed, and never enters the contrast set.
  const weak = examples
    .filter((e) => e.performanceScore !== null && e.performanceScore <= maxScore)
    .sort((a, b) => (a.performanceScore ?? 0) - (b.performanceScore ?? 0));

  // Reserve the strongest row for the mimic list when everything retrieved is
  // weak, so the prompt is never all-failures.
  const reserved = weak.length === examples.length && weak.length > 0 ? weak[weak.length - 1] : null;

  const contrast = weak.filter((e) => e !== reserved).slice(0, cap);
  const chosen = new Set<T>(contrast);

  // Retrieval order is preserved for the mimic list: MMR already ranked these
  // by relevance and diversity and that ordering should survive.
  const mimic = examples.filter((e) => !chosen.has(e));

  return { mimic, contrast };
}
