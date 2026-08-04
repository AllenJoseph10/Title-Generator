// lib/generation/constants.ts
//
// Display constants and the shared read-path helper, in their own module so
// API routes can import them without pulling in orchestrator.ts, which carries
// `import 'server-only'` plus ffmpeg, both provider SDKs and the embedding
// client. A lightweight GET route should not drag that graph in to read the
// integer 5. Mirrors the shape of lib/retrieval/constants.ts.

// Generation still emits 10 candidates; the best DISPLAY_COUNT are shown.
// The rest are persisted, not discarded — they are the only record of real
// generations with real priors attached, which is future eval data.
export const DISPLAY_COUNT = 5;

// The one read path for persisted `generated_titles`.
//
// Sorting here rather than only at write time is deliberate: rows written
// before the ranking change landed are stored in model-emission order, so
// slicing them without sorting would surface an arbitrary DISPLAY_COUNT of
// the 10 — worse than the full list those rows used to show. For rows written
// after the change the sort is a no-op, since they were already stored sorted.
//
// Copies before sorting: the caller's array (often a parsed DB payload reused
// elsewhere in the same handler) must not be reordered underneath it.
export function displayTitles<T extends { templateSimilarityPrior: number }>(titles: T[]): T[] {
  return [...titles]
    .sort((a, b) => b.templateSimilarityPrior - a.templateSimilarityPrior)
    .slice(0, DISPLAY_COUNT);
}
