import { HOOK_FAMILIES, HOOK_TAXONOMY, type HookFamily } from './taxonomy';

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
