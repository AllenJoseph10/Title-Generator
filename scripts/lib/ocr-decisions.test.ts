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

  it('escalates an incoherent read: noTextFound false but no usable primaryTitle', () => {
    // The provider maps an empty/whitespace-only title to null even when
    // noTextFound is false — this must never be trusted enough to reach
    // `included` with no title on it.
    expect(escalationReason(pass({ noTextFound: false, primaryTitle: null })))
      .toBe('title_missing_despite_claim');
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

  it('never includes a reading that claims a title exists but carries none (unescalated)', () => {
    // Defense-in-depth: even if called with pass2 === null (which should not
    // happen for this case under the normal calling convention, since
    // escalationReason() now escalates it), the outcome must not be
    // `included` with an empty title.
    const incoherent = pass({ noTextFound: false, primaryTitle: null });
    const out = resolveOcrOutcome(incoherent, null);
    expect(out.status).not.toBe('included');
    expect(out.burnedInTitle).toBeUndefined();
  });

  it('never includes an incoherent read even when a confirming second pass also finds nothing usable', () => {
    const incoherent = pass({ noTextFound: false, primaryTitle: null });
    const out = resolveOcrOutcome(incoherent, incoherent);
    expect(out.status).not.toBe('included');
  });

  it('routes to review, not included, when an incoherent pass 1 disagrees with a real pass 2 title', () => {
    const incoherent = pass({ noTextFound: false, primaryTitle: null });
    const out = resolveOcrOutcome(incoherent, pass({ primaryTitle: 'A real title' }));
    expect(out.status).toBe('needs_review_disagreement');
  });
});
