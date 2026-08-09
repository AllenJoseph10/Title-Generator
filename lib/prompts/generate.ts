import { HOOK_TAXONOMY, type HookFamily } from '@/lib/hooks/taxonomy';
import { partitionByPerformance } from '@/lib/retrieval/contrast';
import type { CorpusTitle, LikedTitle, VisionDescription } from '@/lib/providers/types';

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

// Render a percentile rank as a band the model can order by.
//
// `performanceScore` is a percentile RANK across the corpus, so 0.88 means the
// row beat 88% of it — the top 12%. Clamped at 1% so the single best row does
// not render as "top 0%", which reads as an error rather than a superlative.
//
// A null score is stated as unmeasured rather than defaulted. Three corpus
// rows genuinely have no share reading, and rendering those as "top 100%"
// would tell the model they were the worst performers — a claim the data does
// not make. Same reasoning as treating a null performance_score as unscored
// rather than zero throughout the importer and prior.
export function performanceBand(score: number | null): string {
  if (score === null) return 'unmeasured';
  return `top ${Math.max(1, Math.round((1 - score) * 100))}%`;
}

// Titles a human kept for visually similar videos.
//
// These are a VOICE signal, not evidence. They were generated, approved, and
// never posted — no share data exists for any of them. The disclaimer is
// load-bearing: corpus examples in the block above carry real measured
// percentiles, and if approval arrives through the same channel the model
// cannot tell the two apart.
export function buildLikedBlock(likes: LikedTitle[]): string {
  if (likes.length === 0) return '';
  const rows = likes
    .map((l) => `- [${l.hookFamily}] ${l.title}\n  written for: ${l.visualDescription}`)
    .join('\n');
  return `

## Titles this creator kept, for videos like this one
Generated earlier and approved by the creator. They carry no performance data — this is a voice signal, not evidence that a pattern earns shares. Weight them for phrasing and tone, not as proof.
${rows}`;
}

// Titles the creator rejected for THIS clip.
//
// Deliberately not folded into the contrast block above: that block states its
// titles ranked near the bottom of the corpus on share rate, which is a claim
// about measured data. A rejected suggestion was never posted.
export function buildRejectedBlock(titles: string[]): string {
  if (titles.length === 0) return '';
  return `

## Rejected for THIS video
The creator saw these for this exact clip and rejected them. Do not produce these or close variants.
${titles.map((t) => `- ${t}`).join('\n')}`;
}

export function buildUserMessage(args: {
  description: VisionDescription;
  retrievedExamples: CorpusTitle[];
  requiredFamilies: HookFamily[];
  likedTitles?: LikedTitle[];
  avoidTitles?: string[];
}): string {
  // The corpus now spans the real performance range, so retrieval can return
  // rows that genuinely did not work. They are split out rather than dropped:
  // dropping them loses the only evidence in the corpus about what fails,
  // while leaving them in the mimic list mostly just gets them mimicked.
  // See lib/retrieval/contrast.ts.
  const { mimic, contrast } = partitionByPerformance(args.retrievedExamples);

  const examples = mimic.length
    ? mimic.map((e) => `- [${e.hookFamily}, ${performanceBand(e.performanceScore)}] ${e.title}`).join('\n')
    : '(no retrieved examples — generate from taxonomy templates and creator voice)';

  const contrastBlock = contrast.length
    ? `

## Titles that did NOT land for videos like this
These are real titles from visually similar videos that ranked near the bottom of the corpus on share rate. Do not imitate them. Read them as evidence of what failed to earn a share here — a hook too vague to create recognition, a setup with no payoff, a line that describes the video instead of giving a reason to send it on.
${contrast.map((e) => `- [${e.hookFamily}, ${performanceBand(e.performanceScore)}] ${e.title}`).join('\n')}`
    : '';

  const likedBlock = buildLikedBlock(args.likedTitles ?? []);
  const rejectedBlock = buildRejectedBlock(args.avoidTitles ?? []);

  return `## Video description
- scene: ${args.description.scene}
- subject: ${args.description.subject}
- setting: ${args.description.setting}
- vibe: ${args.description.vibe.join(', ')}
- visual hook: ${args.description.visualHook}

## Titles from visually similar videos (mimic patterns, do not copy)
Each is tagged with its hook family and how it ranked on share rate across the corpus. A smaller "top N%" performed better, so weight those patterns more heavily. "unmeasured" means no share data exists for that row — draw no conclusion from it either way. Titles that clearly underperformed are not listed here; they appear in their own section below.
${examples}
Do not carry a specific quantity, price, brand, or proper noun from a retrieved example into a new title unless the video description above actually supports it. You are free to invent your own number when the video genuinely shows a countable set.
${likedBlock}
${contrastBlock}
${rejectedBlock}

## REQUIRED hook families (you MUST include at least one title for each)
${args.requiredFamilies.map((f) => `- ${f}`).join('\n')}

Emit exactly 10 titles via the emit_titles tool.`;
}
