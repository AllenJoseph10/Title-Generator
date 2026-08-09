import { describe, expect, it } from 'vitest';
import { performanceBand, buildUserMessage, buildLikedBlock, buildRejectedBlock } from './generate';
import type { CorpusTitle } from '../providers/types';

// The exact heading, so these tests key on the new block rather than on prose
// that also appears in the mimic section.
const CONTRAST_HEADING = '## Titles that did NOT land';

const ex = (title: string, score: number | null): CorpusTitle => ({
  id: title,
  title,
  hookFamily: 'relatable_pov',
  performanceScore: score,
});

describe('performanceBand', () => {
  it('renders a high percentile as a small "top N%"', () => {
    // performanceScore is a percentile RANK: 0.88 means it beat 88% of the
    // corpus, i.e. it sits in the top 12%.
    expect(performanceBand(0.88)).toBe('top 12%');
  });

  it('renders a low percentile as a large "top N%"', () => {
    expect(performanceBand(0.1)).toBe('top 90%');
  });

  it('handles the extremes without producing "top 0%"', () => {
    // A rank of exactly 1.0 is the single best row; calling it "top 0%" would
    // read as an error rather than a superlative.
    expect(performanceBand(1)).toBe('top 1%');
    expect(performanceBand(0)).toBe('top 100%');
  });

  it('says unmeasured for a null score rather than inventing one', () => {
    // Three corpus rows genuinely have no share reading. Rendering them as
    // "top 100%" would tell the model they were the worst performers, which
    // is a claim the data does not make.
    expect(performanceBand(null)).toBe('unmeasured');
  });
});

describe('buildUserMessage', () => {
  const base = {
    description: {
      scene: 'a man walks',
      subject: 'a man',
      setting: 'a street',
      vibe: ['calm'],
      visualHook: 'he turns',
      rawJson: null,
    },
    requiredFamilies: ['relatable_pov' as const],
  };

  it('labels every example with its band', () => {
    const msg = buildUserMessage({
      ...base,
      retrievedExamples: [ex('Winner line', 0.95), ex('Weaker line', 0.2)],
    });
    expect(msg).toContain('[relatable_pov, top 5%] Winner line');
    expect(msg).toContain('[relatable_pov, top 80%] Weaker line');
  });

  it('no longer claims every retrieved example is high-performing', () => {
    // The corpus is about to gain rows that failed the original view gate, so
    // a blanket "high-performing" heading would present an underperformer as a
    // model to copy.
    const msg = buildUserMessage({ ...base, retrievedExamples: [ex('A line', 0.5)] });
    expect(msg).not.toContain('high-performing examples');
  });

  it('tells the model the bands are ordering information, not decoration', () => {
    const msg = buildUserMessage({ ...base, retrievedExamples: [ex('A line', 0.5)] });
    expect(msg).toMatch(/better[- ]performing|performed better|stronger/i);
  });

  it('still handles an empty corpus', () => {
    const msg = buildUserMessage({ ...base, retrievedExamples: [] });
    expect(msg).toContain('no retrieved examples');
  });

  it('keeps the do-not-copy-specifics instruction', () => {
    const msg = buildUserMessage({ ...base, retrievedExamples: [ex('A line', 0.5)] });
    expect(msg).toMatch(/do not copy|Do not carry/i);
  });
});

describe('buildUserMessage — contrast set', () => {
  const base = {
    description: {
      scene: 'a man walks',
      subject: 'a man',
      setting: 'a street',
      vibe: ['calm'],
      visualHook: 'he turns',
      rawJson: null,
    },
    requiredFamilies: ['relatable_pov' as const],
  };

  it('separates underperformers into their own block', () => {
    const msg = buildUserMessage({
      ...base,
      retrievedExamples: [ex('Winner line', 0.95), ex('Flop line', 0.05)],
    });
    const mimicAt = msg.indexOf('Winner line');
    const contrastAt = msg.indexOf('Flop line');
    expect(mimicAt).toBeGreaterThan(-1);
    expect(contrastAt).toBeGreaterThan(mimicAt);
    // The failure must not sit in the list the model is told to copy.
    expect(msg.slice(mimicAt, contrastAt)).toMatch(/did not|underperform|avoid/i);
  });

  it('carries the do-not-imitate instruction inside the contrast block itself', () => {
    // Asserting against the whole message would pass on the pre-existing
    // "mimic patterns, do not copy" heading and prove nothing, so this scopes
    // the check to the text from the contrast heading onward.
    const msg = buildUserMessage({
      ...base,
      retrievedExamples: [ex('Winner line', 0.95), ex('Flop line', 0.05)],
    });
    const block = msg.slice(msg.indexOf(CONTRAST_HEADING));
    expect(block).toMatch(/do not (imitate|copy|reproduce)/i);
  });

  it('omits the contrast block entirely when nothing underperformed', () => {
    const msg = buildUserMessage({
      ...base,
      retrievedExamples: [ex('Winner line', 0.95), ex('Also good', 0.8)],
    });
    expect(msg).not.toContain(CONTRAST_HEADING);
  });

  it('never lists an unmeasured row as a failure', () => {
    const msg = buildUserMessage({
      ...base,
      retrievedExamples: [ex('Winner line', 0.95), ex('No data line', null)],
    });
    const idx = msg.indexOf(CONTRAST_HEADING);
    expect(idx === -1 || msg.indexOf('No data line') < idx).toBe(true);
  });
});

describe('buildLikedBlock', () => {
  const like = {
    title: 'The coat that does all the work',
    hookFamily: 'transformation_tease',
    visualDescription: 'man in a wool overcoat on a city street at dusk',
  };

  it('is empty when there is nothing to show', () => {
    expect(buildLikedBlock([])).toBe('');
  });

  it('renders the title, its family and the description it was written for', () => {
    const out = buildLikedBlock([like]);
    expect(out).toContain('## Titles this creator kept');
    expect(out).toContain(like.title);
    expect(out).toContain('transformation_tease');
    expect(out).toContain('written for: man in a wool overcoat');
  });

  it('states these carry no performance data', () => {
    // Load-bearing: without it the model cannot tell human approval from
    // measured share rate, which is the conflation the corpus design avoids.
    expect(buildLikedBlock([like]).toLowerCase()).toContain('no performance data');
  });
});

describe('buildRejectedBlock', () => {
  it('is empty when there is nothing to reject', () => {
    expect(buildRejectedBlock([])).toBe('');
  });

  it('renders each rejected title under its own heading', () => {
    const out = buildRejectedBlock(['a bad line', 'another bad line']);
    expect(out).toContain('## Rejected for THIS video');
    expect(out).toContain('- a bad line');
    expect(out).toContain('- another bad line');
  });

  it('is not the corpus contrast block', () => {
    // The contrast block claims its titles ranked near the bottom on share
    // rate. Rejected suggestions were never posted, so they must not be
    // filed under that claim.
    expect(buildRejectedBlock(['x'])).not.toContain('share rate');
  });
});
