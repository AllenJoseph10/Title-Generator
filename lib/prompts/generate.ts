import { HOOK_TAXONOMY, type HookFamily } from '@/lib/hooks/taxonomy';
import type { CorpusTitle, VisionDescription } from '@/lib/providers/types';

// The system prompt is split into a CACHED prefix (taxonomy + global rules) and a
// per-creator block (style brief + fingerprint). Both go into Anthropic's `system`
// array with `cache_control: ephemeral` on the boundary so subsequent generations
// for the same creator hit the cache.

export const GENERATE_RULES = `You write burn-in titles for silent short-form videos (Instagram Reels / TikTok). Titles appear as on-screen text the creator types into CapCut. They are NOT spoken.

Your output is read by humans who decide in <1s whether to keep watching. Optimize for: saves and shares per view. The thing that makes a title save-worthy is recognition — "that's literally me" — not cleverness.

Hard rules:
- 10 titles, no more, no less.
- At least one title per REQUIRED hook family listed in the user message.
- 4–14 words per title. Most should be 6–10.
- No em-dashes. No "literally". No "the way [x]". No "POV: when…" (overused).
- No emojis except ✨ is BANNED specifically.
- Lowercase first letter is fine. Sentence case is fine. ALL CAPS is banned.
- No hashtags. No quotes.
- Never invent product names, prices, or locations not shown in the video.
- Match the creator's voice: read their best_titles carefully and mimic rhythm, syntax, and irony level. Do not write in a generic "Reels-bait" voice.

You are called via a single tool, "emit_titles". Always respond by invoking that tool. Never reply in plain text.`;

export function buildTaxonomyBlock(): string {
  const lines: string[] = ['## Hook Families (use the id verbatim)'];
  for (const id of Object.keys(HOOK_TAXONOMY) as HookFamily[]) {
    const meta = HOOK_TAXONOMY[id];
    lines.push(`- ${id}: template "${meta.template}" — e.g. "${meta.example}"`);
  }
  return lines.join('\n');
}

export function buildCreatorBlock(args: { styleBrief: string; styleFingerprint: string[] }): string {
  const fingerprint = args.styleFingerprint.length
    ? `## Creator's best titles (mimic voice)\n${args.styleFingerprint.map((t) => `- ${t}`).join('\n')}`
    : '## Creator voice\n(no fingerprint provided — write in a grounded, dry, slightly self-deprecating voice)';
  return `## Niche style brief\n${args.styleBrief}\n\n${fingerprint}`;
}

export function buildUserMessage(args: {
  description: VisionDescription;
  retrievedExamples: CorpusTitle[];
  requiredFamilies: HookFamily[];
}): string {
  const examples = args.retrievedExamples.length
    ? args.retrievedExamples
        .map((e) => `- [${e.hookFamily}] ${e.title}`)
        .join('\n')
    : '(no retrieved examples — generate from taxonomy templates and creator voice)';

  return `## Video description
- scene: ${args.description.scene}
- subject: ${args.description.subject}
- setting: ${args.description.setting}
- vibe: ${args.description.vibe.join(', ')}
- visual hook: ${args.description.visualHook}

## Retrieved high-performing examples (mimic patterns, do not copy)
${examples}

## REQUIRED hook families (you MUST include at least one title for each)
${args.requiredFamilies.map((f) => `- ${f}`).join('\n')}

Emit exactly 10 titles via the emit_titles tool.`;
}
