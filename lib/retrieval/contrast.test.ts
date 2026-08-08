import { describe, expect, it } from 'vitest';
import { partitionByPerformance, MAX_CONTRAST } from './contrast';

const row = (id: string, performanceScore: number | null) => ({ id, performanceScore });

describe('partitionByPerformance', () => {
  it('keeps a strong row in the mimic list', () => {
    const { mimic, contrast } = partitionByPerformance([row('a', 0.9)]);
    expect(mimic.map((r) => r.id)).toEqual(['a']);
    expect(contrast).toHaveLength(0);
  });

  it('moves a weak row into the contrast list', () => {
    const { mimic, contrast } = partitionByPerformance([row('strong', 0.9), row('weak', 0.1)]);
    expect(mimic.map((r) => r.id)).toEqual(['strong']);
    expect(contrast.map((r) => r.id)).toEqual(['weak']);
  });

  it('never treats an unmeasured row as a failure', () => {
    // A null score means no share reading exists. Presenting it as something
    // that did not land is a claim the data does not make — the same reasoning
    // that keeps null unscored rather than zero in the prior and the importer.
    const { mimic, contrast } = partitionByPerformance([row('unmeasured', null)]);
    expect(contrast).toHaveLength(0);
    expect(mimic.map((r) => r.id)).toEqual(['unmeasured']);
  });

  it('leaves middle-band rows in the mimic list', () => {
    const { mimic, contrast } = partitionByPerformance([row('mid', 0.5)]);
    expect(mimic.map((r) => r.id)).toEqual(['mid']);
    expect(contrast).toHaveLength(0);
  });

  it('caps how many failures are shown', () => {
    const weak = Array.from({ length: 8 }, (_, i) => row(`w${i}`, 0.01 * i));
    const { contrast } = partitionByPerformance([...weak, row('strong', 0.95)]);
    expect(contrast.length).toBeLessThanOrEqual(MAX_CONTRAST);
  });

  it('shows the weakest rows first when it has to choose', () => {
    const { contrast } = partitionByPerformance([
      row('least-bad', 0.30),
      row('worst', 0.01),
      row('middling-bad', 0.15),
      row('strong', 0.9),
    ]);
    expect(contrast.map((r) => r.id)).toEqual(['worst', 'middling-bad', 'least-bad']);
  });

  it('never leaves the mimic list empty, even when every row underperformed', () => {
    // A prompt showing only failures and nothing to imitate is worse than the
    // blanket-positive prompt this replaces.
    const { mimic, contrast } = partitionByPerformance([row('a', 0.05), row('b', 0.02), row('c', 0.01)]);
    expect(mimic.length).toBeGreaterThan(0);
    expect(mimic.map((r) => r.id)).toEqual(['a']); // the strongest of a weak set
    expect(contrast.map((r) => r.id)).toEqual(['c', 'b']);
  });

  it('drops no rows: every input appears in exactly one list', () => {
    const input = [row('a', 0.9), row('b', 0.1), row('c', null), row('d', 0.5), row('e', 0.02)];
    const { mimic, contrast } = partitionByPerformance(input);
    const seen = [...mimic, ...contrast].map((r) => r.id).sort();
    expect(seen).toEqual(['a', 'b', 'c', 'd', 'e']);
    expect(mimic.length + contrast.length).toBe(input.length);
  });

  it('handles an empty corpus', () => {
    expect(partitionByPerformance([])).toEqual({ mimic: [], contrast: [] });
  });

  it('preserves retrieval order within the mimic list', () => {
    // MMR already ordered these by relevance-and-diversity; re-sorting would
    // discard that work.
    const { mimic } = partitionByPerformance([row('first', 0.9), row('second', 0.8), row('third', 0.95)]);
    expect(mimic.map((r) => r.id)).toEqual(['first', 'second', 'third']);
  });
});
