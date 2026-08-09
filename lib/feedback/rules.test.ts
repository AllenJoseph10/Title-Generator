import { describe, it, expect } from 'vitest';
import { sanitizeAvoidTitles, prunableIds, aboveFloor } from './rules';

describe('sanitizeAvoidTitles', () => {
  it('drops non-strings, empties and whitespace-only entries', () => {
    expect(sanitizeAvoidTitles(['a', '', '   ', 3, null, 'b'])).toEqual(['a', 'b']);
  });

  it('truncates each entry to 200 characters', () => {
    const long = 'x'.repeat(250);
    expect(sanitizeAvoidTitles([long])[0]).toHaveLength(200);
  });

  it('keeps only the first 10 entries', () => {
    const many = Array.from({ length: 25 }, (_, i) => `t${i}`);
    expect(sanitizeAvoidTitles(many)).toHaveLength(10);
  });

  it('degrades to an empty list rather than throwing', () => {
    expect(sanitizeAvoidTitles(undefined)).toEqual([]);
    expect(sanitizeAvoidTitles('not an array')).toEqual([]);
    expect(sanitizeAvoidTitles({ 0: 'a' })).toEqual([]);
  });
});

describe('aboveFloor', () => {
  const rows = [{ similarity: 0.9 }, { similarity: 0.5 }, { similarity: 0.49 }];

  it('keeps rows at or above the floor and drops the rest', () => {
    expect(aboveFloor(rows, 0.5)).toEqual([{ similarity: 0.9 }, { similarity: 0.5 }]);
  });

  it('can drop everything', () => {
    expect(aboveFloor(rows, 0.95)).toEqual([]);
  });
});

describe('prunableIds', () => {
  const rows = [
    { id: 'newest', created_at: '2026-08-09T00:00:03Z' },
    { id: 'middle', created_at: '2026-08-09T00:00:02Z' },
    { id: 'oldest', created_at: '2026-08-09T00:00:01Z' },
  ];

  it('returns nothing when under the cap', () => {
    expect(prunableIds(rows, 5)).toEqual([]);
  });

  it('returns nothing when exactly at the cap', () => {
    expect(prunableIds(rows, 3)).toEqual([]);
  });

  it('drops the oldest first', () => {
    expect(prunableIds(rows, 2)).toEqual(['oldest']);
    expect(prunableIds(rows, 1)).toEqual(['middle', 'oldest']);
  });

  it('does not assume the input is sorted', () => {
    const shuffled = [rows[2], rows[0], rows[1]];
    expect(prunableIds(shuffled, 2)).toEqual(['oldest']);
  });
});
