// How densely to sample a clip for burned-in-title OCR.
//
// Fitted to the actual corpus: median clip is 11s and 72% are under 15s, so a
// high floor matters more than a low ceiling. The floor of 8 guarantees enough
// frames to establish that a static title persists; the ceiling of 12 stops a
// 58s clip costing three times a 20s one for no extra signal.
const MIN_FRAMES = 8;
const MAX_FRAMES = 12;
const SECONDS_PER_FRAME_TARGET = 3;
const FALLBACK_INTERVAL_SEC = 2;

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

export function frameCountFor(durationSec: number | null): number {
  if (durationSec === null || !Number.isFinite(durationSec) || durationSec <= 0) {
    return MIN_FRAMES;
  }
  return clamp(Math.ceil(durationSec / SECONDS_PER_FRAME_TARGET), MIN_FRAMES, MAX_FRAMES);
}

export function intervalFor(durationSec: number | null, frameCount: number): number {
  if (durationSec === null || !Number.isFinite(durationSec) || durationSec <= 0) {
    return FALLBACK_INTERVAL_SEC;
  }
  return durationSec / frameCount;
}

// The escalation pass must see different frames than pass 1, or the two reads
// would reproduce the same misreading and never disagree. Half an interval
// places its samples exactly between pass 1's.
export function escalationOffsetFor(intervalSec: number): number {
  return intervalSec / 2;
}
