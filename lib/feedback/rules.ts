// Pure rules for the title feedback loop. No DB, no network — every decision
// here is testable in isolation.

// Client-supplied text that enters a prompt. Bounded rather than trusted.
export const MAX_AVOID_TITLES = 10;
export const MAX_AVOID_LENGTH = 200;

// Newest N liked rows kept per creator. The ledger (title_feedback) is never
// pruned — only this derived index is.
export const LIKED_CAP_PER_CREATOR = 50;

// A malformed avoid list degrades to empty rather than rejecting the request:
// a bad list should not cost the user their generation.
export function sanitizeAvoidTitles(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  return input
    .filter((t): t is string => typeof t === 'string')
    .map((t) => t.trim())
    .filter((t) => t.length > 0)
    .map((t) => t.slice(0, MAX_AVOID_LENGTH))
    .slice(0, MAX_AVOID_TITLES);
}

// Similarity floor. Trivial, but it is the rule that decides whether a kept
// title is about the same kind of video, so it gets a boundary test rather
// than living inline as an untested `.filter`.
export function aboveFloor<T extends { similarity: number }>(rows: T[], floor: number): T[] {
  return rows.filter((r) => r.similarity >= floor);
}

// Which rows to delete so at most `cap` survive. Oldest go first. Sorts its
// own input rather than trusting caller ordering.
export function prunableIds(
  rows: Array<{ id: string; created_at: string }>,
  cap: number,
): string[] {
  if (rows.length <= cap) return [];
  return [...rows]
    .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))
    .slice(cap)
    .map((r) => r.id);
}
