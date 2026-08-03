# Burn-in Title OCR & Visual Description — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extract one verbatim burned-in hook title plus a visual description for each scraped video, and merge the results of all 14 creators into `datasets/william-wade-titles.csv`.

**Architecture:** Three `tsx` scripts driven off `datasets/raw/<handle>/manifest.json`. Stage 2 reads each video once via Claude vision and escalates to a second, offset-sampled read only when the first read's evidence is weak. Stage 2b describes the survivors using the app's existing vision provider unchanged. Stage 6 flattens every manifest into one CSV. All decision logic lives in pure, unit-tested modules under `scripts/lib/`; the scripts themselves only do I/O and orchestration.

**Tech Stack:** TypeScript, `tsx`, `@anthropic-ai/sdk` (`claude-sonnet-4-6`), `ffmpeg-static`, Vitest.

**Spec:** `docs/superpowers/specs/2026-07-31-burn-in-title-ocr-design.md`

## Global Constraints

- **Model:** `claude-sonnet-4-6` for both OCR and descriptions. Do not change `lib/providers/pricing.ts`.
- **Do not modify** `lib/generation/orchestrator.ts`, `lib/retrieval/prior.ts`, `lib/retrieval/search.ts`, `lib/prompts/vision.ts`, or any file under `supabase/`. The schema and retrieval changes are a separate plan.
- **`extractFrames` must stay backward-compatible.** `lib/generation/orchestrator.ts:85` calls `extractFrames(input.videoBytes, TARGET_FRAMES)` with no options and must keep its current behaviour (one frame per 2s from t=0).
- **OCR frame count:** `clamp(ceil(durationSec / 3), 8, 12)`, spread evenly across the whole clip.
- **Description frames:** exactly `extractFrames(bytes, 8)` with no options — reproducing the runtime call byte-for-byte, including its 16-second coverage limit.
- **Verbatim fidelity:** titles are stored exactly as returned. Normalisation is used only for comparison, never for what is written.
- **Manifest writes after every video.** A crash must lose at most one video's work.
- **Never commit secrets.** `.env.local` is gitignored and stays that way.
- `npm run typecheck` must pass after every task.

---

## File Structure

| File | Responsibility |
|---|---|
| `scripts/lib/manifest.ts` | **Create.** Shared `ManifestEntry` type + load/save. Currently duplicated across two scripts. |
| `scripts/lib/frame-plan.ts` | **Create.** Pure: how many frames for a clip, and the escalation offset. |
| `scripts/lib/ocr-decisions.ts` | **Create.** Pure: title normalisation, agreement, escalation trigger, status resolution. The core decision logic. |
| `lib/media/frames.ts` | **Modify.** Add `intervalSec` and `offsetSec` options. |
| `lib/prompts/burned-in-title.ts` | **Modify.** Invert conservatism, add verbatim + partial-reveal + evidence-field rules. |
| `lib/providers/anthropic/burned-in-title.ts` | **Modify.** Add evidence fields to the tool schema; remove the stale crop wording. |
| `scripts/extract-burned-in-titles.ts` | **Rewrite.** Orchestration + escalation + end-of-run report + `--recheck`. |
| `scripts/describe-videos.ts` | **Create.** Stage 2b. |
| `scripts/merge-dataset.ts` | **Create.** Stage 6. |
| `datasets/README.md` | **Modify.** Document `visual_description`; fix the stale hook-family list. |

---

## Task 1: Test harness and shared manifest types

**Files:**
- Modify: `package.json`
- Create: `scripts/lib/manifest.ts`
- Test: `scripts/lib/manifest.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `ManifestEntry` type, `loadManifest(dir): Promise<ManifestEntry[]>`, `saveManifest(dir, entries): Promise<void>`, `manifestPath(dir): string`. Used by Tasks 5, 6, 7.

There is no test runner in this project. Every subsequent task tests pure decision logic where a silent bug corrupts the dataset, so the runner comes first.

- [ ] **Step 1: Install Vitest**

```bash
npm install -D vitest@^3.0.0
```

- [ ] **Step 2: Add the test script**

In `package.json`, add to `"scripts"` (keep the existing entries):

```json
"test": "vitest run",
"test:watch": "vitest"
```

- [ ] **Step 3: Write the failing test**

Create `scripts/lib/manifest.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadManifest, saveManifest, manifestPath, type ManifestEntry } from './manifest';

const entry = (over: Partial<ManifestEntry> = {}): ManifestEntry => ({
  shortcode: 'ABC123',
  permalink: 'https://www.instagram.com/reel/ABC123/',
  caption: 'a caption',
  views: 1000,
  likes: 10,
  comments: 1,
  postedAt: '2026-01-01',
  durationSec: 12,
  videoUrl: 'https://cdn/x.mp4',
  status: 'scraped',
  ...over,
});

describe('manifest', () => {
  it('returns an empty array when no manifest exists', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mf-'));
    expect(await loadManifest(dir)).toEqual([]);
  });

  it('round-trips entries through save and load', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mf-'));
    const entries = [entry(), entry({ shortcode: 'DEF456', status: 'included' })];
    await saveManifest(dir, entries);
    expect(await loadManifest(dir)).toEqual(entries);
  });

  it('preserves unknown fields written by other stages', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mf-'));
    const withExtra = { ...entry(), burnedInTitle: 'A title', titleFrameRatio: 0.9 };
    await saveManifest(dir, [withExtra]);
    const [loaded] = await loadManifest(dir);
    expect(loaded.burnedInTitle).toBe('A title');
    expect(loaded.titleFrameRatio).toBe(0.9);
  });

  it('builds the manifest path', () => {
    expect(manifestPath('/tmp/x')).toBe(path.join('/tmp/x', 'manifest.json'));
  });
});
```

- [ ] **Step 4: Run the test to verify it fails**

Run: `npm test -- scripts/lib/manifest.test.ts`
Expected: FAIL — `Failed to resolve import "./manifest"`.

- [ ] **Step 5: Write the implementation**

Create `scripts/lib/manifest.ts`:

```ts
import fs from 'node:fs/promises';
import path from 'node:path';

// One record per post evaluated, written by every stage. Nothing is ever
// deleted: excluded posts keep their reason so any decision can be re-audited
// without re-running the model.
export type ManifestEntry = {
  // Stage 1 — scrape
  shortcode: string;
  permalink: string;
  caption: string;
  views: number | null;
  likes: number | null;
  comments: number | null;
  postedAt: string | null;
  durationSec: number | null;
  videoUrl: string | null;
  status: string;
  videoPath?: string;
  outlierMultiplier?: number;
  viewsPerDay?: number;
  rank?: 'top' | 'bottom';
  duplicateOfHandle?: string;

  // Stage 2 — OCR
  burnedInTitle?: string;
  additionalTitles?: string[];
  titleFrameRatio?: number;
  partialReveal?: boolean;
  captionsPresent?: boolean;
  escalated?: boolean;
  escalationReason?: string;
  ocrCostUsd?: number;
  ocrPasses?: unknown[]; // raw provider responses, for audit

  // Stage 2b — describe
  visualDescription?: string;
  descriptionFields?: {
    scene: string;
    subject: string;
    setting: string;
    vibe: string[];
    visualHook: string;
  };
  describeCostUsd?: number;
  describeError?: string;
};

export function manifestPath(dir: string): string {
  return path.join(dir, 'manifest.json');
}

export async function loadManifest(dir: string): Promise<ManifestEntry[]> {
  try {
    return JSON.parse(await fs.readFile(manifestPath(dir), 'utf8')) as ManifestEntry[];
  } catch {
    return [];
  }
}

export async function saveManifest(dir: string, entries: ManifestEntry[]): Promise<void> {
  await fs.writeFile(manifestPath(dir), JSON.stringify(entries, null, 2));
}
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `npm test -- scripts/lib/manifest.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 7: Verify typecheck still passes**

Run: `npm run typecheck`
Expected: no output, exit 0.

- [ ] **Step 8: Commit**

```bash
git add package.json package-lock.json scripts/lib/manifest.ts scripts/lib/manifest.test.ts
git commit -m "test: add vitest and shared manifest types"
```

---

## Task 2: Frame planning and offset sampling

**Files:**
- Create: `scripts/lib/frame-plan.ts`
- Test: `scripts/lib/frame-plan.test.ts`
- Modify: `lib/media/frames.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `frameCountFor(durationSec: number | null): number`, `intervalFor(durationSec: number | null, frameCount: number): number`, `escalationOffsetFor(intervalSec: number): number`. Used by Task 5.
- Produces: `extractFrames(input, count, { cropTopFraction?, intervalSec?, offsetSec? })`. Used by Tasks 5 and 6.

- [ ] **Step 1: Write the failing test for frame planning**

Create `scripts/lib/frame-plan.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { frameCountFor, intervalFor, escalationOffsetFor } from './frame-plan';

describe('frameCountFor', () => {
  it('gives short clips the floor of 8 frames', () => {
    expect(frameCountFor(6)).toBe(8);
    expect(frameCountFor(11)).toBe(8); // the corpus median
    expect(frameCountFor(24)).toBe(8);
  });

  it('scales in the middle of the range', () => {
    expect(frameCountFor(30)).toBe(10);
    expect(frameCountFor(33)).toBe(11);
  });

  it('caps long clips at 12 frames', () => {
    expect(frameCountFor(45)).toBe(12);
    expect(frameCountFor(58)).toBe(12);
  });

  it('falls back to the floor when duration is unknown', () => {
    expect(frameCountFor(null)).toBe(8);
  });
});

describe('intervalFor', () => {
  it('spreads the frames across the whole clip', () => {
    expect(intervalFor(30, 10)).toBeCloseTo(3);
    expect(intervalFor(12, 8)).toBeCloseTo(1.5);
  });

  it('uses a 2s interval when duration is unknown', () => {
    expect(intervalFor(null, 8)).toBe(2);
  });
});

describe('escalationOffsetFor', () => {
  it('lands the second pass exactly between the first pass frames', () => {
    expect(escalationOffsetFor(3)).toBeCloseTo(1.5);
    expect(escalationOffsetFor(1.5)).toBeCloseTo(0.75);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm test -- scripts/lib/frame-plan.test.ts`
Expected: FAIL — cannot resolve `./frame-plan`.

- [ ] **Step 3: Implement frame planning**

Create `scripts/lib/frame-plan.ts`:

```ts
// How densely to sample a clip for burned-in-title OCR.
//
// Fitted to the actual corpus: median clip is 11s and 72% are under 15s, so a
// high floor matters more than a low ceiling. The floor of 8 guarantees enough
// frames to establish that a static title persists; the ceiling of 12 stops a
// 58s clip costing three times a 20s one for no extra signal.
const MIN_FRAMES = 8;
const MAX_FRAMES = 12;
const SECONDS_PER_FRAME_TARGET = 3;
const FALLBACK_INTERVAL_SEC = 2;

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

export function frameCountFor(durationSec: number | null): number {
  if (durationSec === null || !Number.isFinite(durationSec) || durationSec <= 0) {
    return MIN_FRAMES;
  }
  return clamp(Math.ceil(durationSec / SECONDS_PER_FRAME_TARGET), MIN_FRAMES, MAX_FRAMES);
}

export function intervalFor(durationSec: number | null, frameCount: number): number {
  if (durationSec === null || !Number.isFinite(durationSec) || durationSec <= 0) {
    return FALLBACK_INTERVAL_SEC;
  }
  return durationSec / frameCount;
}

// The escalation pass must see different frames than pass 1, or the two reads
// would reproduce the same misreading and never disagree. Half an interval
// places its samples exactly between pass 1's.
export function escalationOffsetFor(intervalSec: number): number {
  return intervalSec / 2;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- scripts/lib/frame-plan.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 5: Add interval and offset support to extractFrames**

In `lib/media/frames.ts`, replace the `ExtractFramesOptions` type and the body of `extractFrames` up to and including the `args` array with:

```ts
export type ExtractFramesOptions = {
  // Keep only the top portion of each sampled frame (e.g. 0.5 = top half).
  // Useful for isolating burned-in title overlays from unrelated content lower in frame.
  cropTopFraction?: number;
  // Seconds between sampled frames. Defaults to 2 so existing callers
  // (the generation orchestrator) keep their current behaviour.
  intervalSec?: number;
  // Skip this many seconds before sampling. Used to take a second, disjoint
  // sample of the same clip.
  offsetSec?: number;
};

export async function extractFrames(
  input: Buffer,
  count: number,
  opts: ExtractFramesOptions = {},
): Promise<Buffer[]> {
  if (!ffmpegPath) {
    throw new Error('ffmpeg-static did not resolve a binary path on this platform');
  }
  if (count < 1) throw new Error(`count must be >= 1 (got ${count})`);
  const { cropTopFraction, intervalSec = 2, offsetSec } = opts;
  if (cropTopFraction !== undefined && (cropTopFraction <= 0 || cropTopFraction > 1)) {
    throw new Error(`cropTopFraction must be in (0, 1] (got ${cropTopFraction})`);
  }
  if (intervalSec <= 0) throw new Error(`intervalSec must be > 0 (got ${intervalSec})`);
  if (offsetSec !== undefined && offsetSec < 0) {
    throw new Error(`offsetSec must be >= 0 (got ${offsetSec})`);
  }

  return withTempVideoFile(input, async (filePath) => {
    const cropFilter = cropTopFraction !== undefined && cropTopFraction < 1
      ? `crop=iw:ih*${cropTopFraction}:0:0,`
      : '';
    const args = [
      '-hide_banner',
      '-loglevel', 'error',
      // Input seeking: must precede -i.
      ...(offsetSec !== undefined && offsetSec > 0 ? ['-ss', String(offsetSec)] : []),
      '-i', filePath,
      '-vf', `${cropFilter}fps=${1 / intervalSec},scale=720:-2`,
      '-frames:v', String(count),
      '-f', 'image2pipe',
      '-vcodec', 'mjpeg',
      'pipe:1',
    ];
```

Leave everything from `const proc = spawn(...)` onward unchanged.

- [ ] **Step 6: Verify the default path is unchanged**

Run: `npm run typecheck`
Expected: no output, exit 0.

The default `intervalSec = 2` renders `fps=0.5`, which is numerically identical to the previous hard-coded `fps=1/2`, so `orchestrator.ts` behaviour is untouched.

- [ ] **Step 7: Commit**

```bash
git add scripts/lib/frame-plan.ts scripts/lib/frame-plan.test.ts lib/media/frames.ts
git commit -m "feat: frame planning helpers and interval/offset sampling"
```

---

## Task 3: OCR decision logic

**Files:**
- Create: `scripts/lib/ocr-decisions.ts`
- Test: `scripts/lib/ocr-decisions.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `type OcrPass`, `type OcrOutcome`, `normaliseTitle(s)`, `titlesAgree(a, b)`, `escalationReason(pass): string | null`, `resolveOcrOutcome(pass1, pass2): OcrOutcome`. Used by Task 5.

This is where a silent bug corrupts the dataset, so it is pure and exhaustively tested.

- [ ] **Step 1: Write the failing test**

Create `scripts/lib/ocr-decisions.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  normaliseTitle,
  titlesAgree,
  escalationReason,
  resolveOcrOutcome,
  type OcrPass,
} from './ocr-decisions';

const pass = (over: Partial<OcrPass> = {}): OcrPass => ({
  primaryTitle: 'The art of dressing classy',
  additionalTitles: [],
  noTextFound: false,
  framesWithTitle: [0, 1, 2, 3, 4, 5, 6, 7],
  totalFrames: 8,
  captionsPresent: false,
  partialReveal: false,
  uncertain: false,
  ...over,
});

describe('normaliseTitle', () => {
  it('ignores casing', () => {
    expect(normaliseTitle('The Art Of Dressing')).toBe(normaliseTitle('the art of dressing'));
  });

  it('ignores trailing ellipsis and punctuation', () => {
    expect(normaliseTitle('Marry the man…')).toBe(normaliseTitle('Marry the man'));
    expect(normaliseTitle('"If you buy one"')).toBe(normaliseTitle('If you buy one'));
  });

  it('ignores emoji', () => {
    expect(normaliseTitle('Find someone 🙏')).toBe(normaliseTitle('Find someone'));
  });

  it('collapses whitespace', () => {
    expect(normaliseTitle('  a   b  ')).toBe('a b');
  });
});

describe('titlesAgree', () => {
  it('accepts casing and punctuation differences', () => {
    expect(titlesAgree('The Art of Dressing Classy', 'the art of dressing classy…')).toBe(true);
  });

  it('rejects genuinely different sentences', () => {
    expect(titlesAgree('The art of dressing classy', 'How to dress well at 30')).toBe(false);
  });

  it('rejects when either side is null', () => {
    expect(titlesAgree(null, 'anything')).toBe(false);
    expect(titlesAgree('anything', null)).toBe(false);
  });
});

describe('escalationReason', () => {
  it('does not escalate a clean read', () => {
    expect(escalationReason(pass())).toBeNull();
  });

  it('escalates when the model is uncertain', () => {
    expect(escalationReason(pass({ uncertain: true }))).toBe('uncertain');
  });

  it('escalates a no-title claim so a faint title is not silently discarded', () => {
    expect(escalationReason(pass({ noTextFound: true, framesWithTitle: [], primaryTitle: null })))
      .toBe('no_title_claim');
  });

  it('escalates a multi-title claim before discarding the row', () => {
    expect(escalationReason(pass({ additionalTitles: ['Part 2'] }))).toBe('multi_title_claim');
  });

  it('escalates when persistence is not established', () => {
    expect(escalationReason(pass({ framesWithTitle: [0, 1] }))).toBe('low_frame_coverage');
  });

  it('escalates when captions are present and coverage is patchy', () => {
    expect(escalationReason(pass({ captionsPresent: true, framesWithTitle: [0, 1, 2, 3] })))
      .toBe('captions_ambiguous');
  });

  it('does not escalate when captions are present but the title is clearly persistent', () => {
    expect(escalationReason(pass({ captionsPresent: true }))).toBeNull();
  });
});

describe('resolveOcrOutcome', () => {
  it('includes an unescalated clean read', () => {
    const out = resolveOcrOutcome(pass(), null);
    expect(out.status).toBe('included');
    expect(out.burnedInTitle).toBe('The art of dressing classy');
    expect(out.escalated).toBe(false);
    expect(out.titleFrameRatio).toBe(1);
  });

  it('stores the raw title verbatim, not the normalised form', () => {
    const raw = 'Marry the man who irons your "dinner outfit" 🙏';
    const out = resolveOcrOutcome(pass({ primaryTitle: raw }), null);
    expect(out.burnedInTitle).toBe(raw);
  });

  it('includes when both passes agree after normalisation', () => {
    const out = resolveOcrOutcome(
      pass({ uncertain: true }),
      pass({ primaryTitle: 'the art of dressing classy…' }),
    );
    expect(out.status).toBe('included');
    expect(out.burnedInTitle).toBe('The art of dressing classy');
    expect(out.escalated).toBe(true);
  });

  it('excludes when both passes confirm multiple titles', () => {
    const out = resolveOcrOutcome(
      pass({ additionalTitles: ['Part 2'] }),
      pass({ additionalTitles: ['Part 2: the reveal'] }),
    );
    expect(out.status).toBe('excluded_multi_title');
  });

  it('routes to review when only one pass saw a second title', () => {
    const out = resolveOcrOutcome(pass({ additionalTitles: ['Part 2'] }), pass());
    expect(out.status).toBe('needs_review_disagreement');
  });

  it('excludes when both passes confirm no title', () => {
    const empty = pass({ noTextFound: true, primaryTitle: null, framesWithTitle: [] });
    expect(resolveOcrOutcome(empty, empty).status).toBe('excluded_no_title');
  });

  it('routes to review when one pass found a title and the other did not', () => {
    const empty = pass({ noTextFound: true, primaryTitle: null, framesWithTitle: [] });
    expect(resolveOcrOutcome(empty, pass()).status).toBe('needs_review_disagreement');
  });

  it('routes to review when the two passes read different titles', () => {
    const out = resolveOcrOutcome(
      pass({ uncertain: true }),
      pass({ primaryTitle: 'A completely different hook' }),
    );
    expect(out.status).toBe('needs_review_disagreement');
  });

  it('routes to review when both passes are uncertain', () => {
    const out = resolveOcrOutcome(pass({ uncertain: true }), pass({ uncertain: true }));
    expect(out.status).toBe('needs_review_uncertain');
  });

  it('routes to review when the title appeared in a single frame in both passes', () => {
    const thin = pass({ framesWithTitle: [3], uncertain: true });
    const out = resolveOcrOutcome(thin, pass({ framesWithTitle: [4] }));
    expect(out.status).toBe('needs_review_single_frame');
  });

  it('carries the partialReveal and captionsPresent flags through', () => {
    const out = resolveOcrOutcome(pass({ partialReveal: true, captionsPresent: true }), null);
    expect(out.partialReveal).toBe(true);
    expect(out.captionsPresent).toBe(true);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm test -- scripts/lib/ocr-decisions.test.ts`
Expected: FAIL — cannot resolve `./ocr-decisions`.

- [ ] **Step 3: Implement the decision logic**

Create `scripts/lib/ocr-decisions.ts`:

```ts
// Pure decision logic for burned-in-title OCR. No I/O, no API calls — a bug in
// here silently corrupts the dataset, so it is isolated and exhaustively tested.

export type OcrPass = {
  primaryTitle: string | null;
  additionalTitles: string[];
  noTextFound: boolean;
  framesWithTitle: number[];
  totalFrames: number;
  captionsPresent: boolean;
  partialReveal: boolean;
  uncertain: boolean;
};

export type OcrOutcome = {
  status: string;
  burnedInTitle?: string;
  additionalTitles?: string[];
  titleFrameRatio: number;
  partialReveal: boolean;
  captionsPresent: boolean;
  escalated: boolean;
  escalationReason?: string;
};

// Coverage below this, with captions on screen, is the caption/title confusion
// case and is worth a second read.
const AMBIGUOUS_COVERAGE = 0.6;
// At or below this many frames, persistence simply has not been established.
const MIN_PERSISTENCE_FRAMES = 2;

// Comparison-only. Never use the output as the stored title — verbatim
// phrasing (casing, punctuation, emoji, typos) is what the corpus exists to teach.
export function normaliseTitle(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .replace(/[\p{P}\p{S}]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function titlesAgree(a: string | null, b: string | null): boolean {
  if (a === null || b === null) return false;
  return normaliseTitle(a) === normaliseTitle(b);
}

export function coverageOf(p: OcrPass): number {
  if (p.totalFrames <= 0) return 0;
  return p.framesWithTitle.length / p.totalFrames;
}

// Returns why a second pass is warranted, or null to accept pass 1 alone.
// Order matters: a no-title claim reports zero frames, so it must be checked
// before the coverage rules or it would be misattributed.
export function escalationReason(p: OcrPass): string | null {
  if (p.uncertain) return 'uncertain';
  if (p.noTextFound) return 'no_title_claim';
  if (p.additionalTitles.length > 0) return 'multi_title_claim';
  if (p.framesWithTitle.length <= MIN_PERSISTENCE_FRAMES) return 'low_frame_coverage';
  if (p.captionsPresent && coverageOf(p) < AMBIGUOUS_COVERAGE) return 'captions_ambiguous';
  return null;
}

export function resolveOcrOutcome(pass1: OcrPass, pass2: OcrPass | null): OcrOutcome {
  const base = {
    titleFrameRatio: coverageOf(pass1),
    partialReveal: pass1.partialReveal || (pass2?.partialReveal ?? false),
    captionsPresent: pass1.captionsPresent || (pass2?.captionsPresent ?? false),
    escalated: pass2 !== null,
    escalationReason: escalationReason(pass1) ?? undefined,
  };

  // No escalation: pass 1's evidence was unambiguous by definition.
  if (pass2 === null) {
    return { ...base, status: 'included', burnedInTitle: pass1.primaryTitle ?? undefined };
  }

  if (pass1.noTextFound && pass2.noTextFound) {
    return { ...base, status: 'excluded_no_title' };
  }
  if (pass1.noTextFound !== pass2.noTextFound) {
    return { ...base, status: 'needs_review_disagreement' };
  }

  const multi1 = pass1.additionalTitles.length > 0;
  const multi2 = pass2.additionalTitles.length > 0;
  if (multi1 && multi2) {
    return {
      ...base,
      status: 'excluded_multi_title',
      burnedInTitle: pass1.primaryTitle ?? undefined,
      additionalTitles: pass1.additionalTitles,
    };
  }
  if (multi1 !== multi2) {
    return { ...base, status: 'needs_review_disagreement' };
  }

  if (pass1.uncertain && pass2.uncertain) {
    return { ...base, status: 'needs_review_uncertain' };
  }

  if (!titlesAgree(pass1.primaryTitle, pass2.primaryTitle)) {
    return { ...base, status: 'needs_review_disagreement' };
  }

  const bestCoverage = Math.max(pass1.framesWithTitle.length, pass2.framesWithTitle.length);
  if (bestCoverage <= 1) {
    return {
      ...base,
      status: 'needs_review_single_frame',
      burnedInTitle: pass1.primaryTitle ?? undefined,
    };
  }

  return { ...base, status: 'included', burnedInTitle: pass1.primaryTitle ?? undefined };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- scripts/lib/ocr-decisions.test.ts`
Expected: PASS, 25 tests.

- [ ] **Step 5: Verify typecheck**

Run: `npm run typecheck`
Expected: no output, exit 0.

- [ ] **Step 6: Commit**

```bash
git add scripts/lib/ocr-decisions.ts scripts/lib/ocr-decisions.test.ts
git commit -m "feat: OCR agreement, escalation and status resolution logic"
```

---

## Task 4: Prompt and tool schema

**Files:**
- Modify: `lib/prompts/burned-in-title.ts`
- Modify: `lib/providers/anthropic/burned-in-title.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `transcribeBurnedInTitle(jpegs): Promise<BurnedInTitleResult>` where `BurnedInTitleResult` now carries `framesWithTitle`, `totalFrames`, `captionsPresent`, `partialReveal`, `uncertain` alongside the existing fields. Used by Task 5.

- [ ] **Step 1: Replace the system prompt**

Replace the entire contents of `lib/prompts/burned-in-title.ts` with:

```ts
export const BURNED_IN_TITLE_SYSTEM_PROMPT = `You read burned-in hook titles from short vertical videos for a dataset-building pipeline. You receive several frames sampled evenly across the whole clip (not just the opening), in order.

A video can contain up to three kinds of on-screen text. Tell them apart by how they BEHAVE across the frame sequence, not by where they sit on screen — a hook title can be positioned anywhere from the top to the middle of the frame, so position alone is not a reliable signal.

1. HOOK TITLE (this is what you're looking for) — a deliberate, complete phrase or sentence the creator overlaid to grab attention (e.g. "The one watch every man should own before 30"). Key signal: it stays VISUALLY IDENTICAL across every frame it appears in, and it is usually a static overlay present for much of the clip.

2. AUTO-GENERATED SPEECH CAPTIONS (ignore these completely — never report as a title) — short fragments transcribing spoken audio, often word-by-word. Key signal: the text is DIFFERENT in nearly every sampled frame, because it tracks natural speech. If what you're seeing changes from frame to frame and reads like transcribed speech rather than a crafted opening line, it is a caption, not a title.

3. INCIDENTAL SCENE TEXT (ignore) — text physically part of the environment (signage, product labels, a phone screen). It shows perspective, lighting, or partial occlusion consistent with the 3D scene.

You will be called via a single tool, "transcribe_title". Always respond by invoking that tool, never plain text.

TRANSCRIBE VERBATIM. Report the hook title exactly as it appears: original capitalisation, punctuation, emoji, line breaks rendered as single spaces, and any spelling errors the creator made. Do not correct, tidy, translate, or normalise anything. The exact wording is the data.

WHEN IN DOUBT, SAY SO. This dataset is harmed far more by a wrong title than by a missing one. If you cannot confidently tell whether persistent text is a hook title or a slowly-changing caption, set uncertain=true rather than guessing either way. A flagged video gets a human review; a confidently wrong one silently corrupts the data.

Field meanings:
- primaryTitle: the hook title text, verbatim. Empty string if no hook title overlay is visible in any frame.
- additionalTitles: populate ONLY if the hook-title overlay itself changes to a genuinely different complete message partway through the clip — e.g. "Part 1: the arrival" later replaced by "Part 2: the reveal". A single sentence that is progressively revealed, animates in, or fades is ONE title, not several: report the fullest version you see in primaryTitle and set partialReveal=true. Speech captions changing underneath a static title never belong here.
- noTextFound: true if no hook title overlay is visible in any frame (captions or scene text alone do not count).
- framesWithTitle: the 0-based indices of every frame in which you can see the hook title. Frames are numbered in the order given. This is the evidence for your judgement — a real static title appears in most frames, a caption line appears in one or two.
- totalFrames: how many frames you were given.
- captionsPresent: true if speech captions were visible anywhere in the clip, whether or not a hook title was also present.
- partialReveal: true if the hook title was animated in or built up across frames rather than appearing complete and static.
- uncertain: true if you cannot confidently classify what you saw.`;
```

- [ ] **Step 2: Update the tool schema and result type**

In `lib/providers/anthropic/burned-in-title.ts`, replace the `TRANSCRIBE_TOOL` constant and the `BurnedInTitleResult` type with:

```ts
const TRANSCRIBE_TOOL: Anthropic.Tool = {
  name: 'transcribe_title',
  description:
    'Report the burned-in hook title found in the supplied video frames, with the frame-level evidence for the judgement.',
  input_schema: {
    type: 'object',
    properties: {
      primaryTitle: { type: 'string' },
      additionalTitles: { type: 'array', items: { type: 'string' } },
      noTextFound: { type: 'boolean' },
      framesWithTitle: { type: 'array', items: { type: 'integer' } },
      totalFrames: { type: 'integer' },
      captionsPresent: { type: 'boolean' },
      partialReveal: { type: 'boolean' },
      uncertain: { type: 'boolean' },
    },
    required: [
      'primaryTitle',
      'additionalTitles',
      'noTextFound',
      'framesWithTitle',
      'totalFrames',
      'captionsPresent',
      'partialReveal',
      'uncertain',
    ],
  },
};

export type BurnedInTitleResult = {
  primaryTitle: string | null;
  additionalTitles: string[];
  noTextFound: boolean;
  framesWithTitle: number[];
  totalFrames: number;
  captionsPresent: boolean;
  partialReveal: boolean;
  uncertain: boolean;
  costUsd: number;
  tokensIn: number;
  tokensOut: number;
};
```

- [ ] **Step 3: Update the response mapping**

In the same file, replace the block from `const out = toolUse.input as ...` to the end of the `return` statement with:

```ts
  const out = toolUse.input as {
    primaryTitle: string;
    additionalTitles: string[];
    noTextFound: boolean;
    framesWithTitle: number[];
    totalFrames: number;
    captionsPresent: boolean;
    partialReveal: boolean;
    uncertain: boolean;
  };

  const tokensIn = res.usage.input_tokens;
  const tokensOut = res.usage.output_tokens;
  const costUsd = anthropicCost(MODEL, { input: tokensIn, output: tokensOut });

  return {
    primaryTitle: out.noTextFound || !out.primaryTitle?.trim() ? null : out.primaryTitle.trim(),
    additionalTitles: out.additionalTitles ?? [],
    noTextFound: out.noTextFound,
    // Trust our own frame count over the model's self-report.
    framesWithTitle: (out.framesWithTitle ?? []).filter((i) => i >= 0 && i < jpegs.length),
    totalFrames: jpegs.length,
    captionsPresent: out.captionsPresent ?? false,
    partialReveal: out.partialReveal ?? false,
    uncertain: out.uncertain ?? false,
    costUsd,
    tokensIn,
    tokensOut,
  };
}
```

- [ ] **Step 4: Verify typecheck**

Run: `npm run typecheck`
Expected: no output, exit 0.

The schema change is purely **additive** — the existing `scripts/extract-burned-in-titles.ts` reads only `costUsd`, `noTextFound`, `primaryTitle`, and `additionalTitles`, all of which the new type still carries. Adding the evidence fields breaks no consumer. Task 5 rewrites that script to start *using* the new fields, but nothing forces it to compile-error first.

Do not add casts, `@ts-ignore`, or edits to `scripts/extract-burned-in-titles.ts` in this task.

- [ ] **Step 5: Commit**

```bash
git add lib/prompts/burned-in-title.ts lib/providers/anthropic/burned-in-title.ts
git commit -m "feat: discard-on-doubt prompt and frame-level evidence fields"
```

---

## Task 5: Rewrite the OCR script

**Files:**
- Rewrite: `scripts/extract-burned-in-titles.ts`

**Interfaces:**
- Consumes: `manifest.ts`, `frame-plan.ts`, `ocr-decisions.ts` (Tasks 1–3), `extractFrames` (Task 2), `transcribeBurnedInTitle` (Task 4).
- Produces: manifest rows with OCR status and evidence. Consumed by Tasks 6 and 7.

- [ ] **Step 1: Replace the whole file**

Replace the entire contents of `scripts/extract-burned-in-titles.ts` with:

```ts
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
  escalationReason,
  resolveOcrOutcome,
  titlesAgree,
  type OcrPass,
} from './lib/ocr-decisions';
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
    if (rest[i] === '--recheck') recheck = parseInt(rest[++i], 10);
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
  const r = await transcribeBurnedInTitle(jpegs);
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
  let escalations = 0;
  let failed = 0;
  const counts = new Map<string, number>();
  const review: Array<{ e: ManifestEntry; p1: OcrPass; p2: OcrPass | null; status: string }> = [];
  const recheckDiffs: string[] = [];

  for (const entry of pending) {
    const videoPath = path.join(dir, entry.videoPath!);
    try {
      const videoBytes = await fs.readFile(videoPath);

      const first = await readPass(videoBytes, entry.durationSec, undefined);
      if (!first) {
        if (!recheck) {
          entry.status = 'needs_review_too_short';
          await saveManifest(dir, manifest);
        }
        counts.set('needs_review_too_short', (counts.get('needs_review_too_short') ?? 0) + 1);
        console.log(`  ${entry.shortcode}: needs_review_too_short`);
        continue;
      }
      totalCost += first.costUsd;

      let second: Awaited<ReturnType<typeof readPass>> = null;
      if (escalationReason(first.pass) !== null) {
        const count = frameCountFor(entry.durationSec);
        const offset = escalationOffsetFor(intervalFor(entry.durationSec, count));
        second = await readPass(videoBytes, entry.durationSec, offset);
        if (second) {
          totalCost += second.costUsd;
          escalations++;
        }
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
        continue;
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
    } catch (e) {
      failed++;
      console.error(`  ${entry.shortcode}: FAILED — ${(e as Error).message}`);
    }
  }

  console.log('\n─── Report ───');
  for (const [status, n] of [...counts.entries()].sort()) console.log(`  ${status.padEnd(28)} ${n}`);
  const rate = pending.length > 0 ? (escalations / pending.length) * 100 : 0;
  console.log(`  ${'escalation rate'.padEnd(28)} ${rate.toFixed(0)}% (${escalations}/${pending.length})`);
  if (rate < 10 || rate > 35) {
    console.log('  ⚠ Outside the 10–35% acceptance range — inspect before trusting this batch.');
  }
  console.log(`  ${'failed'.padEnd(28)} ${failed}`);
  console.log(`  ${'cost'.padEnd(28)} $${totalCost.toFixed(4)}`);

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
```

- [ ] **Step 2: Verify typecheck passes**

Run: `npm run typecheck`
Expected: no output, exit 0. The Task 4 errors are now resolved.

- [ ] **Step 3: Verify all unit tests still pass**

Run: `npm test`
Expected: PASS, 36 tests across 3 files.

- [ ] **Step 4: Smoke-test against one real video without spending much**

Run: `npx tsx scripts/extract-burned-in-titles.ts itisbainz`

`itisbainz` has only 2 scraped videos, so this costs about $0.08 and exercises the full path. Confirm the output shows a status per video, a report block, and that `datasets/raw/itisbainz/manifest.json` gained `burnedInTitle` and `titleFrameRatio` fields.

- [ ] **Step 5: Commit**

```bash
git add scripts/extract-burned-in-titles.ts
git commit -m "feat: single-pass OCR with escalation, quarantine and run report"
```

---

## Task 6: Description script

**Files:**
- Create: `scripts/describe-videos.ts`
- Modify: `package.json`

**Interfaces:**
- Consumes: `manifest.ts` (Task 1), `extractFrames` (Task 2), and the existing `anthropicVision` provider.
- Produces: manifest rows with `visualDescription` and `descriptionFields`. Consumed by Task 7.

- [ ] **Step 1: Create the script**

Create `scripts/describe-videos.ts`:

```ts
// Stage 2b — describe each included video, so corpus rows can be retrieved by
// what the video SHOWS rather than by title wording.
// Usage: tsx scripts/describe-videos.ts <handle>
//
// Reuses lib/providers/anthropic/vision.ts unchanged, at the same 8 frames the
// generation orchestrator uses. That is deliberate: retrieval compares this
// description against the description the app generates for an uploaded video,
// and embedding similarity only holds if both sides come from the same prompt,
// the same model, and the same frame sampling.

import fs from 'node:fs/promises';
import path from 'node:path';
import { loadEnvLocal, requireEnv } from './lib/load-env';
import { loadManifest, saveManifest } from './lib/manifest';
import { extractFrames } from '../lib/media/frames';
import { anthropicVision } from '../lib/providers/anthropic/vision';

// Matches TARGET_FRAMES in lib/generation/orchestrator.ts.
const DESCRIBE_FRAMES = 8;

function parseArgs(argv: string[]) {
  const [handle] = argv;
  if (!handle) {
    console.error('Usage: describe-videos <handle>');
    process.exit(1);
  }
  return { handle };
}

async function main() {
  loadEnvLocal();
  requireEnv(['ANTHROPIC_API_KEY']);

  const { handle } = parseArgs(process.argv.slice(2));
  const dir = path.join(process.cwd(), 'datasets', 'raw', handle);
  const manifest = await loadManifest(dir);

  const pending = manifest.filter(
    (e) => e.status === 'included' && e.videoPath && !e.visualDescription,
  );
  console.log(`${pending.length} videos to describe for @${handle}`);

  let totalCost = 0;
  let done = 0;
  let failed = 0;

  for (const entry of pending) {
    try {
      const videoBytes = await fs.readFile(path.join(dir, entry.videoPath!));
      // No options — reproduces the orchestrator's call exactly.
      const jpegs = await extractFrames(videoBytes, DESCRIBE_FRAMES);
      const res = await anthropicVision.describe({ kind: 'frames', jpegs });
      const d = res.description;

      entry.descriptionFields = {
        scene: d.scene,
        subject: d.subject,
        setting: d.setting,
        vibe: d.vibe,
        visualHook: d.visualHook,
      };
      // Byte-for-byte the concatenation orchestrator.ts uses to build queryText.
      entry.visualDescription = `${d.scene} ${d.visualHook}`;
      entry.describeCostUsd = res.costUsd;
      delete entry.describeError;
      totalCost += res.costUsd;
      done++;
      console.log(`  ${entry.shortcode}: ${entry.visualDescription.slice(0, 90)}…`);
    } catch (e) {
      // A failed description must never discard a good title — record and move on.
      entry.describeError = (e as Error).message;
      failed++;
      console.error(`  ${entry.shortcode}: FAILED — ${(e as Error).message}`);
    }
    await saveManifest(dir, manifest);
  }

  console.log(`\nDone. described=${done} failed=${failed} cost=$${totalCost.toFixed(4)}`);
  if (failed > 0) console.log('Re-run this command to retry the failures.');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
```

- [ ] **Step 2: Add the npm script**

In `package.json`, add to `"scripts"`:

```json
"describe:videos": "tsx scripts/describe-videos.ts"
```

- [ ] **Step 3: Verify typecheck**

Run: `npm run typecheck`
Expected: no output, exit 0.

- [ ] **Step 4: Smoke-test on the creator processed in Task 5**

Run: `npx tsx scripts/describe-videos.ts itisbainz`

Confirm each line prints a plausible scene sentence, and that `manifest.json` now has `visualDescription` and `descriptionFields` on the included rows. Cost should be roughly $0.03 per video.

- [ ] **Step 5: Commit**

```bash
git add scripts/describe-videos.ts package.json
git commit -m "feat: visual description stage reusing the app vision provider"
```

---

## Task 7: Merge to CSV and update dataset docs

**Files:**
- Create: `scripts/merge-dataset.ts`
- Modify: `package.json`
- Modify: `datasets/README.md`
- Test: `scripts/lib/csv.test.ts`
- Create: `scripts/lib/csv.ts`

**Interfaces:**
- Consumes: `manifest.ts` (Task 1).
- Produces: `datasets/william-wade-titles.csv`.

- [ ] **Step 1: Write the failing CSV test**

Create `scripts/lib/csv.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { csvField, csvRow } from './csv';

describe('csvField', () => {
  it('leaves simple values unquoted', () => {
    expect(csvField('hello')).toBe('hello');
    expect(csvField(42)).toBe('42');
  });

  it('renders null and undefined as empty', () => {
    expect(csvField(null)).toBe('');
    expect(csvField(undefined)).toBe('');
  });

  it('quotes values containing a comma', () => {
    expect(csvField('a, b')).toBe('"a, b"');
  });

  it('quotes and doubles embedded quotes', () => {
    expect(csvField('say "hi"')).toBe('"say ""hi"""');
  });

  it('quotes values containing newlines', () => {
    expect(csvField('line1\nline2')).toBe('"line1\nline2"');
  });
});

describe('csvRow', () => {
  it('joins fields with commas', () => {
    expect(csvRow(['a', 1, null, 'x, y'])).toBe('a,1,,"x, y"');
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm test -- scripts/lib/csv.test.ts`
Expected: FAIL — cannot resolve `./csv`.

- [ ] **Step 3: Implement the CSV helpers**

Create `scripts/lib/csv.ts`:

```ts
// RFC-4180 field quoting. Captions routinely contain commas, quotes and
// newlines; without this a single caption can shift every later column.
export function csvField(v: string | number | null | undefined): string {
  if (v === null || v === undefined) return '';
  const s = String(v);
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

export function csvRow(values: Array<string | number | null | undefined>): string {
  return values.map(csvField).join(',');
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- scripts/lib/csv.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Create the merge script**

Create `scripts/merge-dataset.ts`:

```ts
// Stage 6 — merge every creator's manifest into the single dataset CSV.
// Usage: tsx scripts/merge-dataset.ts
//
// Only `included` rows are emitted. Everything else stays in the manifests
// with its reason, so nothing is lost and any exclusion can be re-audited.

import fs from 'node:fs/promises';
import path from 'node:path';
import { loadManifest } from './lib/manifest';
import { csvRow } from './lib/csv';

const HEADER = [
  'video_id', 'date_posted', 'platform', 'creator_handle', 'video_url',
  'burned_in_title', 'caption', 'views', 'likes', 'comments', 'shares',
  'saves', 'duration_sec', 'niche', 'hook_family', 'notes', 'visual_description',
];

const NICHE = 'luxury-menswear';
const OUT = path.join(process.cwd(), 'datasets', 'william-wade-titles.csv');

async function main() {
  const rawRoot = path.join(process.cwd(), 'datasets', 'raw');
  const handles = (await fs.readdir(rawRoot, { withFileTypes: true }))
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();

  const lines: string[] = [];
  let id = 0;
  let missingDescription = 0;

  for (const handle of handles) {
    const entries = await loadManifest(path.join(rawRoot, handle));
    const included = entries.filter((e) => e.status === 'included' && e.burnedInTitle);
    for (const e of included) {
      id++;
      if (!e.visualDescription) missingDescription++;
      lines.push(csvRow([
        id,
        e.postedAt,
        'reels',
        handle,
        e.permalink,
        e.burnedInTitle,
        e.caption,
        e.views,
        e.likes,
        e.comments,
        '', // shares — private analytics, unscrapable
        '', // saves  — private analytics, unscrapable
        e.durationSec,
        NICHE,
        '', // hook_family — assigned by the importer from lib/hooks/taxonomy.ts
        e.partialReveal ? 'partial_reveal' : '',
        e.visualDescription,
      ]));
    }
    console.log(`  ${handle.padEnd(20)} ${included.length} rows`);
  }

  // UTF-8 BOM so Excel renders emoji and smart quotes correctly on open.
  await fs.writeFile(OUT, '﻿' + [csvRow(HEADER), ...lines].join('\n') + '\n');

  console.log(`\nWrote ${lines.length} rows to ${OUT}`);
  if (missingDescription > 0) {
    console.log(`⚠ ${missingDescription} rows have no visual_description — run describe:videos first.`);
  }
  if (lines.length < 200) {
    console.log(`⚠ ${lines.length} rows is below the 200-row floor for the prior to be meaningful.`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
```

- [ ] **Step 6: Add the npm script**

In `package.json`, add to `"scripts"`:

```json
"merge:dataset": "tsx scripts/merge-dataset.ts"
```

- [ ] **Step 7: Update the dataset docs**

In `datasets/README.md`, replace the `hook_family` row of the "Optional / leave blank" table with:

```markdown
| `hook_family` | **Leave blank.** The importer auto-classifies into one of: `relatable_pov`, `setup_trivial_reveal`, `listicle_reveal`, `reaction_humblebrag`, `transformation_tease` (see `lib/hooks/taxonomy.ts`). |
```

Then add these rows to the same table:

```markdown
| `visual_description` | **Auto-generated.** A short factual description of what the video shows, produced by `npm run describe:videos`. Do not fill in by hand — it must come from the same vision prompt the app uses at query time, or retrieval degrades. |
| `notes` | Anything unusual. `partial_reveal` is set automatically when the burned-in title animated in rather than appearing complete. |
```

The old hook-family list named five families that exist nowhere in the codebase and would fail the `corpus_titles.hook_family` foreign key on insert.

- [ ] **Step 8: Verify typecheck and the full test suite**

Run: `npm run typecheck && npm test`
Expected: typecheck silent, tests PASS (42 across 4 files).

- [ ] **Step 9: Generate the CSV and inspect it**

Run: `npx tsx scripts/merge-dataset.ts`

Confirm the header has 17 columns, `video_id` numbers from 1 with no gaps, and that opening the file shows titles with their original casing and emoji intact.

- [ ] **Step 10: Commit**

```bash
git add scripts/merge-dataset.ts scripts/lib/csv.ts scripts/lib/csv.test.ts package.json datasets/README.md
git commit -m "feat: merge manifests into the dataset CSV with visual_description"
```

---

## Running the batch

Once all seven tasks are complete, run the real batch in two stages, as budgeted in spec §9.1.

**Stage A — titles (~$5.63 of ~$20):**

**Invoke through the npm scripts, not `npx tsx` directly.** `lib/providers/anthropic/vision.ts` starts with `import 'server-only'`, which throws under plain Node. The `describe:videos` npm script carries `--conditions=react-server` to resolve that; a direct `npx tsx scripts/describe-videos.ts` call bypasses the flag and crashes. Use `npm run <script> -- <handle>` uniformly so both stages behave the same way.

```bash
for h in aligordon bielvalldo budrys.jr bycarlosroberto hqfran itisbainz \
         julesfrankenn khaleelaqrabawi m.iles marvinbrooks philipdeml \
         rowanrow rsimacourbe; do
  npm run extract:titles -- "$h"
done
npm run extract:titles -- henryjwade --recheck 20
```

Then complete the spec §10 audit before spending anything further:

1. Escalation rate within 10–35%.
2. Audit 10 `included` rows against their videos — titles verbatim, none a caption.
3. Audit every `needs_review_disagreement` row.
4. Audit 5 `excluded_multi_title` rows — this is the discard path.
5. Recheck reports fewer than 2 of 20 differing, or plan a full henryjwade re-run (~$4.21).

**Stage B — descriptions (~$6.28), only after the audit passes:**

```bash
for h in $(ls datasets/raw); do npm run describe:videos -- "$h"; done
npm run merge:dataset
```

If the audit fails, fix `lib/prompts/burned-in-title.ts`, reset the affected rows to `scraped`, and re-run Stage A (~$4.76). The reserve exists for exactly this.

---

## Out of scope

Deliberately excluded — these belong to the schema/importer plan:

- `supabase/migrations/0003_descriptions.sql`
- The `match_corpus_titles` RPC rebuild
- `lib/retrieval/search.ts` and MMR moving to `description_embedding`
- `scripts/import-dataset.mjs`, `scripts/eval.mjs`, `EVAL.md`
- The niche selector UI
