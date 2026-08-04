// Pure geometry for client-side upload preparation. No DOM, no codecs, so
// every dimension decision is unit-testable — which matters because the
// failure it guards against is silent: a wrongly-rotated upload produces
// fluent, confident, wrong vision descriptions and raises nothing anywhere.
//
// Imported relatively rather than via the `@/` alias: there is no
// vitest.config in this repo, so the alias does not resolve under test.

import { MAX_BYTES } from '../storage/constants';

// The server runs `-vf "fps=0.5,scale=720:-2"`, so anything wider than this is
// discarded after upload regardless.
export const TARGET_WIDTH = 720;

// The server samples 8 frames at 2s intervals; the last lands at a measured
// t=14.0s. 16s is deliberate margin, so keyframe placement or rounding cannot
// cost the eighth frame.
export const TRIM_SEC = 16;

export type Rotation = 0 | 90 | 180 | 270;

// Phone video is routinely stored as a landscape frame plus a rotation flag.
// IMG_1795.MOV is coded 3840x2160 carrying "rotation of -90.00 degrees" and
// displays as 2160x3840.
export function rotatedDimensions(
  codedWidth: number,
  codedHeight: number,
  rotation: Rotation,
): { width: number; height: number } {
  return rotation === 90 || rotation === 270
    ? { width: codedHeight, height: codedWidth }
    : { width: codedWidth, height: codedHeight };
}

function toEven(n: number): number {
  const r = Math.max(2, Math.round(n));
  return r % 2 === 0 ? r : r + 1;
}

// Scale to TARGET_WIDTH, preserving aspect. Dimensions come back even because
// H.264 requires it. The rounding need not match ffmpeg's `-2` exactly: the
// server re-runs scale=720:-2 on whatever it receives, which is a no-op once
// the width is already 720.
export function scaleToTarget(width: number, height: number): { width: number; height: number } {
  if (width <= TARGET_WIDTH) return { width: toEven(width), height: toEven(height) };
  return { width: TARGET_WIDTH, height: toEven((height * TARGET_WIDTH) / width) };
}

// Skip the decode/encode entirely when it cannot help. Boundaries pass on
// purpose: the API rejects `size > MAX_BYTES`, so treating the cap itself as
// needing work would be stricter than the gate this feeds.
export function needsWork(o: {
  sizeBytes: number;
  durationSec: number;
  displayWidth: number;
}): boolean {
  return o.sizeBytes > MAX_BYTES || o.durationSec > TRIM_SEC || o.displayWidth > TARGET_WIDTH;
}
