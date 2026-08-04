import { describe, expect, it } from 'vitest';
import { performanceBand, buildUserMessage } from './generate';
import type { CorpusTitle } from '../providers/types';

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
