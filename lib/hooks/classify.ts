import { HOOK_FAMILIES, HOOK_TAXONOMY, type HookFamily } from './taxonomy';

// Which hook families should the generator be required to cover?
//
// Derived from the videos retrieval actually found similar, rather than from
// keyword matching on vibe adjectives. An audit of classifyCandidates against
// the 175 labelled corpus rows (scripts/audit-family-selector.ts) found it
// returned only 6 distinct sets, with 83% of rows getting the identical three
// — its 73.7% hit rate was just the base rate of the three most common
// families, not classification. Worst of all it requested
// reaction_humblebrag, the family with the strongest prior correlation in the
// eval (0.411), for only 12% of rows, and listicle_reveal for none.
//
// Structurally typed on hookFamily alone so this stays pure and testable
// without dragging in the CorpusTitle type or its module graph.
//
// Returns [] when there are no neighbours; the caller decides the fallback.
// Deliberately does NOT pad to a minimum: if eight visually-similar videos all
// used one hook, that is signal, and padding it back to three is the exact
// behaviour this replaces.
export function familiesFromNeighbours(
  examples: ReadonlyArray<{ hookFamily: HookFamily }>,
  max = 3,
): HookFamily[] {
  const counts = new Map<HookFamily, number>();
  for (const e of examples) counts.set(e.hookFamily, (counts.get(e.hookFamily) ?? 0) + 1);

  return [...counts.entries()]
    .sort((a, b) =>
      // Frequency first; ties broken by declaration order so the same video
      // always yields the same prompt.
      b[1] - a[1] || HOOK_FAMILIES.indexOf(a[0]) - HOOK_FAMILIES.indexOf(b[0]),
    )
    .slice(0, max)
    .map(([family]) => family);
}

// Rule-based candidate selector. Counts trigger-keyword overlaps in vibe + visualHook.
// Returns at least 3 families so the generator has variety; falls back to all 5 if nothing matches.

export function classifyCandidates(vibe: ReadonlyArray<string>, visualHook: string): HookFamily[] {
  const haystack = [...vibe, visualHook].join(' ').toLowerCase();

  const scored = HOOK_FAMILIES.map((id) => {
    const meta = HOOK_TAXONOMY[id];
    let score = 0;
    for (const trigger of meta.triggers) {
      if (haystack.includes(trigger.toLowerCase())) score += 1;
    }
    return { id, score };
  });

  const withMatches = scored.filter((s) => s.score > 0).sort((a, b) => b.score - a.score);
  if (withMatches.length >= 3) return withMatches.map((s) => s.id);

  // Top up to at least 3 with the remaining families (deterministic order).
  const picked = new Set(withMatches.map((s) => s.id));
  for (const id of HOOK_FAMILIES) {
    if (picked.size >= 3) break;
    picked.add(id);
  }
  return Array.from(picked);
}
