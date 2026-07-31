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
