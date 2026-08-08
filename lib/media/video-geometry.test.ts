import { describe, expect, it } from 'vitest';
import { MAX_BYTES } from '../storage/constants';
import {
  TARGET_WIDTH,
  TRIM_SEC,
  rotatedDimensions,
  scaleToTarget,
  needsWork,
} from './video-geometry';

describe('rotatedDimensions', () => {
  it('leaves an unrotated frame alone', () => {
    expect(rotatedDimensions(1920, 1080, 0)).toEqual({ width: 1920, height: 1080 });
  });

  it('swaps axes at 90 degrees', () => {
    expect(rotatedDimensions(3840, 2160, 90)).toEqual({ width: 2160, height: 3840 });
  });

  it('swaps axes at 270 degrees', () => {
    // IMG_1795.MOV reports "rotation of -90.00 degrees", normalised to 270.
    expect(rotatedDimensions(3840, 2160, 270)).toEqual({ width: 2160, height: 3840 });
  });

  it('leaves axes alone at 180 degrees', () => {
    expect(rotatedDimensions(1920, 1080, 180)).toEqual({ width: 1920, height: 1080 });
  });
});

describe('scaleToTarget', () => {
  it('reproduces the measured reference for IMG_1795.MOV', () => {
    // Coded 3840x2160 with a -90 display matrix -> displayed 2160x3840.
    // The server's scale=720:-2 was MEASURED to produce 720x1280 on this file.
    // A result of 720x405 here would mean rotation was not applied, and the
    // upload would be sideways — which raises no error anywhere downstream.
    const rotated = rotatedDimensions(3840, 2160, 270);
    expect(scaleToTarget(rotated.width, rotated.height)).toEqual({ width: 720, height: 1280 });
  });

  it('scales a landscape source down to the target width', () => {
    const r = scaleToTarget(1920, 1080);
    expect(r.width).toBe(720);
    expect(r.height % 2).toBe(0); // H.264 requires even dimensions
    expect(Math.abs(r.height - 405)).toBeLessThanOrEqual(1);
  });

  it('leaves a source narrower than the target alone', () => {
    expect(scaleToTarget(640, 480)).toEqual({ width: 640, height: 480 });
  });

  it('always returns even dimensions', () => {
    const r = scaleToTarget(1081, 607);
    expect(r.width % 2).toBe(0);
    expect(r.height % 2).toBe(0);
  });

  it('never returns a zero dimension for a tiny source', () => {
    const r = scaleToTarget(2, 1);
    expect(r.width).toBeGreaterThan(0);
    expect(r.height).toBeGreaterThan(0);
  });
});

describe('needsWork', () => {
  const base = { sizeBytes: 1_000_000, durationSec: 5, displayWidth: 480 };

  it('skips a small, short, narrow clip', () => {
    expect(needsWork(base)).toBe(false);
  });

  it('triggers on size alone', () => {
    expect(needsWork({ ...base, sizeBytes: MAX_BYTES + 1 })).toBe(true);
  });

  it('triggers on duration alone', () => {
    expect(needsWork({ ...base, durationSec: TRIM_SEC + 0.1 })).toBe(true);
  });

  it('triggers on width alone', () => {
    expect(needsWork({ ...base, displayWidth: TARGET_WIDTH + 1 })).toBe(true);
  });

  it('does not trigger exactly at the boundaries', () => {
    // The server rejects `size > MAX_BYTES`, so the cap itself is allowed.
    // Being stricter here than the API would mean preparing files the API
    // would have accepted untouched.
    expect(needsWork({ sizeBytes: MAX_BYTES, durationSec: TRIM_SEC, displayWidth: TARGET_WIDTH }))
      .toBe(false);
  });

  it('triggers for IMG_1795.MOV', () => {
    // 83309337 bytes, 13.89s, displayed 2160 wide — over on size and width,
    // under on duration. The real motivating case.
    expect(needsWork({ sizeBytes: 83_309_337, durationSec: 13.89, displayWidth: 2160 })).toBe(true);
  });
});
