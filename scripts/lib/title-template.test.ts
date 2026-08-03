import { describe, expect, it } from 'vitest';
import { templatiseTitle } from './title-template';

describe('templatiseTitle', () => {
  it('replaces a bare cardinal quantifying a content noun', () => {
    expect(templatiseTitle('6 Old Money Outfits Every Man Needs')).toBe(
      '{N} Old Money Outfits Every Man Needs',
    );
  });

  it('leaves a duration in dialogue unchanged', () => {
    const t = 'Her: "I\'ll be there in 5 minutes"\n\nMe:';
    expect(templatiseTitle(t)).toBe(t);
  });

  it('leaves a measurement unchanged', () => {
    const t = 'POV: the UV index is 9...';
    expect(templatiseTitle(t)).toBe(t);
  });

  it('leaves a rank unchanged, even though the noun after it is on the whitelist', () => {
    const t = 'Number 1 tourist mistake in New York...';
    expect(templatiseTitle(t)).toBe(t);
  });

  it('leaves a price unchanged', () => {
    const t = 'Giving a famous chef a £1,500 style transformation';
    expect(templatiseTitle(t)).toBe(t);
  });

  it('leaves a year unchanged', () => {
    const t = 'How to Elevate your Content in 2026...';
    expect(templatiseTitle(t)).toBe(t);
  });

  it('leaves an age decade unchanged', () => {
    const t = "Nobody warns you about this in your 30's";
    expect(templatiseTitle(t)).toBe(t);
  });

  it('leaves a product spec unchanged', () => {
    const t = "If she isn't forcing SPF 50+ on you she's not that into you...";
    expect(templatiseTitle(t)).toBe(t);
  });

  it('leaves a number inside a proper noun unchanged', () => {
    const t = 'Clever Ways Formula 1 Actually Makes Money';
    expect(templatiseTitle(t)).toBe(t);
  });

  it('leaves a percentage unchanged', () => {
    const t = 'Hugh Grant scene from Love Actually\n96% accuracy...';
    expect(templatiseTitle(t)).toBe(t);
  });

  it('leaves a duration ("your skin deserves 5 minutes") unchanged', () => {
    const t = 'your skin deserves 5 minutes';
    expect(templatiseTitle(t)).toBe(t);
  });

  it('leaves a duration ("after 7 years") unchanged', () => {
    const t = 'Updating my passport photo after 7 years...';
    expect(templatiseTitle(t)).toBe(t);
  });

  it('leaves a duration ("waited 2 hours") unchanged', () => {
    const t = 'When I waited 2 hours for her to get ready...';
    expect(templatiseTitle(t)).toBe(t);
  });

  it('leaves a frequency unchanged', () => {
    const t = 'Hot take: men who only spray 3 times probably also order matcha.';
    expect(templatiseTitle(t)).toBe(t);
  });

  // --- Additional edge cases ---

  it('does NOT handle number-word forms (documented limitation)', () => {
    const t = 'Six Old Money Outfits Every Man Needs';
    expect(templatiseTitle(t)).toBe(t);
  });

  it('templates only the qualifying number when a title has several', () => {
    const t = '7 Rules Every Man Breaks by 30';
    expect(templatiseTitle(t)).toBe('{N} Rules Every Man Breaks by 30');
  });

  it('leaves a title with no numbers at all unchanged', () => {
    const t = 'Old Money Outfits Every Man Needs';
    expect(templatiseTitle(t)).toBe(t);
  });

  it('templates a singular content noun quantified by 1', () => {
    expect(templatiseTitle('1 Mistake Every Guy Makes on a First Date')).toBe(
      '{N} Mistake Every Guy Makes on a First Date',
    );
  });

  it('templates a noun matched close but not adjacent, at the edge of the window', () => {
    expect(templatiseTitle('3 things you should absolutely never do')).toBe(
      '{N} things you should absolutely never do',
    );
  });

  it('does not template a rank written as "#1"', () => {
    const t = '#1 mistake every man makes';
    expect(templatiseTitle(t)).toBe(t);
  });

  it('does not template a second unrelated number after a stop character', () => {
    // "5" quantifies nothing in this clause; the noun after the colon
    // belongs to a different clause and is out of window/stopped at ":".
    const t = 'Day 5: outfits I never wear again';
    expect(templatiseTitle(t)).toBe(t);
  });

  it('templates every qualifying number when a title has more than one', () => {
    expect(templatiseTitle('5 mistakes, 3 tips')).toBe('{N} mistakes, {N} tips');
  });

  it('is a pure function (does not mutate its input, safe to call repeatedly)', () => {
    const t = '6 Old Money Outfits Every Man Needs';
    const first = templatiseTitle(t);
    const second = templatiseTitle(t);
    expect(first).toBe(second);
    expect(t).toBe('6 Old Money Outfits Every Man Needs');
  });

  // --- Decimal regression (fix round 1) ---
  // A decimal like "4.5" or "19.99" must never fragment into two number
  // matches ("4"/"5" or "19"/"99") where either half could be mistaken for
  // a standalone quantity next to a content noun. You cannot have 4.5
  // outfits, so decimals are disqualified outright, not just protected by
  // the currency/percent/rank guards (which only inspect the character
  // immediately touching the match and previously missed this).

  it('leaves a rating decimal immediately followed by a content noun unchanged', () => {
    const t = 'Rated 4.5 outfits out of 5';
    expect(templatiseTitle(t)).toBe(t);
  });

  it('leaves a price-with-cents immediately followed by a content noun unchanged', () => {
    const t = '$19.99 outfits for under $20';
    expect(templatiseTitle(t)).toBe(t);
  });

  it('leaves a bare decimal with a content noun directly after it unchanged', () => {
    const t = '4.5 outfits';
    expect(templatiseTitle(t)).toBe(t);
  });

  it('leaves a decimal with no content noun anywhere unchanged', () => {
    const t = 'My rating is 4.5 out of 5 stars';
    expect(templatiseTitle(t)).toBe(t);
  });

  // --- Compound numeric expressions (fix round 2) ---
  // Round 1 consumed "\d+\.\d+" as a single token, which only caught
  // decimals with a leading digit. It missed ".5" (no leading digit) and
  // anything using "/" instead of "." (fractions/ratios) or more than one
  // separator (version-like sequences). The general principle: a digit run
  // adjacent to "." or "/" with no space is a component of a compound
  // numeric expression, never itself a count of discrete items — that
  // covers all of these uniformly, at any nesting depth.

  it('leaves a rating-out-of-5 with a slash unchanged', () => {
    const t = 'Top 4.5/5 outfits';
    expect(templatiseTitle(t)).toBe(t);
  });

  it('leaves a leading-dot decimal (no leading digit) unchanged', () => {
    const t = '.5 outfits';
    expect(templatiseTitle(t)).toBe(t);
  });

  it('leaves a version-like dotted sequence unchanged', () => {
    const t = '6.1.2 ways';
    expect(templatiseTitle(t)).toBe(t);
  });

  it('leaves a bare fraction unchanged', () => {
    const t = '3/5 outfits';
    expect(templatiseTitle(t)).toBe(t);
  });

  it('does not treat a sentence-ending period as a compound-punctuation decimal point', () => {
    // "6." here is a full stop (followed by a space), not a decimal point,
    // so the compound-punctuation guard must not fire on it. (It stays
    // unchanged for an unrelated reason too — the noun is in the next
    // clause, past the period — but this asserts the guard itself is not
    // over-eager here.)
    const t = 'You need 6. Outfits matter.';
    expect(templatiseTitle(t)).toBe(t);
  });

  it('still templates a genuine comma-grouped quantity', () => {
    expect(templatiseTitle('1,500 outfits')).toBe('{N} outfits');
  });

  it('treats a European-style comma-decimal as an unresolved compound and leaves it unchanged', () => {
    // "4,5" is ambiguous (European decimal vs. a genuine "4, 5" list with a
    // dropped space); this corpus is English-language, so we resolve the
    // ambiguity conservatively rather than risk mangling one half of it.
    const t = '4,5 outfits';
    expect(templatiseTitle(t)).toBe(t);
  });
});
