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
