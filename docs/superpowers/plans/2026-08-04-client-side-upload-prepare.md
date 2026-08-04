# Client-Side Upload Preparation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Trim to 16s, rotate correctly, downscale to 720px wide and drop audio in the browser before upload, so ordinary phone clips fit the 50 MB cap without hand transcoding.

**Architecture:** One client-side module, `lib/media/prepare-upload.ts`, wrapping a WebCodecs decode → canvas → encode → MP4 mux pipeline, fronted by pure geometry helpers in `lib/media/video-geometry.ts`. It never throws: every failure path returns the original `File`, which then meets the existing `rejectUpload()` gate exactly as it does today.

**Tech Stack:** TypeScript, WebCodecs (`VideoDecoder`/`VideoEncoder`), `OffscreenCanvas`, `mp4-muxer@5.2.2`, vitest.

**Spec:** `docs/superpowers/specs/2026-08-04-client-side-upload-prepare-design.md`

## Global Constraints

- **`prepareUpload` must never throw and never block an upload.** Every failure path returns the input `File` unchanged. Any file that uploads successfully today must still upload successfully.
- **Rotation is the highest-severity risk in the spec.** A sideways upload yields confident, fluent, wrong vision descriptions with no error anywhere. Assert output orientation; never assume it.
- **Measured reference:** `IMG_1795.MOV` is coded 3840×2160 with `displaymatrix: rotation of -90.00 degrees`. The server's `scale=720:-2` produces **720×1280** — portrait. Any implementation producing 720×405 from this file is wrong.
- Output must be `video/mp4`. `ACCEPTED_MIME`, `MAX_BYTES`, the bucket's `allowed_mime_types` and its `file_size_limit` are all **untouched**.
- Trim at **16s**. The last frame the server samples is at a measured t=14.0s; 16s is deliberate margin.
- Target width **720px**; drop audio entirely.
- The preview must keep using `URL.createObjectURL(file)` on the **original** file. Do not change `app/(app)/page.tsx`.
- Encoder dimensions must be even; H.264 requires it.
- Chrome/Edge only. No Safari or Firefox fallback path is in scope.
- Tests use `import { describe, expect, it } from 'vitest'` and live beside their source.

---

## File Structure

| File | Responsibility |
|---|---|
| `lib/media/video-geometry.ts` | **New.** Pure: rotation resolution, 720px scaling, the "is work needed" predicate |
| `lib/media/video-geometry.test.ts` | **New.** Unit tests for all of the above |
| `lib/media/prepare-upload.ts` | **New.** The WebCodecs pipeline; the only impure part |
| `components/app/upload-dropzone.tsx` | **Modified.** Await `prepareUpload` before `rejectUpload`; add a preparing state |
| `package.json` | **Modified.** Add `mp4-muxer` |

---

### Task 1: Feasibility spike — does HEVC decode at all?

**Files:**
- Create: `scratch-webcodecs-probe.html` (throwaway, **must be deleted in Step 5**)

**Interfaces:**
- Consumes: nothing
- Produces: a go/no-go answer. Nothing downstream imports from this task.

The spec names HEVC decode as the risk that could make this feature pointless: Chrome's support is conditional on platform and hardware, and iPhone clips are the main use case. Building the pipeline before knowing is potentially days of wasted work. **Do this first and stop if it fails.**

- [ ] **Step 1: Write the probe page**

```html
<!doctype html>
<meta charset="utf-8">
<title>WebCodecs probe</title>
<style>body{font:14px system-ui;padding:24px;max-width:60ch}pre{background:#f4f4f4;padding:12px;white-space:pre-wrap}</style>
<h1>WebCodecs feasibility probe</h1>
<input type="file" accept="video/mp4,video/quicktime">
<pre id="out">Pick IMG_1795.MOV…</pre>
<script type="module">
const out = document.getElementById('out');
const log = (s) => { out.textContent += '\n' + s; };

out.textContent = 'WebCodecs present: ' + ('VideoDecoder' in window);

document.querySelector('input').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  log('file: ' + file.name + ' — ' + file.size + ' bytes, type=' + file.type);

  // What does a plain <video> element report? Browsers apply rotation here,
  // so these are DISPLAY dimensions, not coded ones.
  const v = document.createElement('video');
  v.preload = 'metadata';
  v.src = URL.createObjectURL(file);
  await new Promise((res, rej) => {
    v.onloadedmetadata = res;
    v.onerror = () => rej(new Error('video element could not load this file'));
  });
  log('<video> duration: ' + v.duration.toFixed(2) + 's');
  log('<video> videoWidth x videoHeight: ' + v.videoWidth + ' x ' + v.videoHeight);
  log(v.videoHeight > v.videoWidth
    ? '  -> PORTRAIT as displayed (rotation applied by the browser)'
    : '  -> LANDSCAPE as displayed');

  // Can WebCodecs decode this codec at all? Try both HEVC fourccs.
  for (const codec of ['hvc1.1.6.L93.B0', 'hev1.1.6.L93.B0', 'avc1.640028']) {
    try {
      const s = await VideoDecoder.isConfigSupported({ codec, codedWidth: 3840, codedHeight: 2160 });
      log('isConfigSupported(' + codec + '): ' + s.supported);
    } catch (err) {
      log('isConfigSupported(' + codec + '): threw — ' + err.message);
    }
  }

  // Can we actually get pixels out? This is the real test — support flags lie.
  try {
    const bmp = await createImageBitmap(v);
    log('createImageBitmap from <video>: OK, ' + bmp.width + ' x ' + bmp.height);
    log(bmp.height > bmp.width
      ? '  -> bitmap is PORTRAIT (rotation baked in by the element)'
      : '  -> bitmap is LANDSCAPE (rotation NOT applied — canvas path must rotate)');
  } catch (err) {
    log('createImageBitmap failed: ' + err.message);
  }
});
</script>
```

- [ ] **Step 2: Serve it and open it**

Run: `npx serve -l 4321 .` from the repo root (or copy the file into `public/` and use the running dev server at `http://localhost:3000/scratch-webcodecs-probe.html`).

Open the page in Chrome and select `C:\Users\essam\Downloads\IMG_1795.MOV`.

- [ ] **Step 3: Record the four answers**

Write down verbatim:
1. `WebCodecs present:` — expected `true` on Chrome/Edge
2. `<video> videoWidth x videoHeight` — expected `2160 x 3840` if the browser applies the −90° matrix
3. `isConfigSupported` for each of the three codecs
4. Whether `createImageBitmap` returns a portrait or landscape bitmap

Answer 4 is the one that decides the implementation: if the bitmap comes back portrait, the `<video>` element has already applied rotation and the canvas path can draw it directly. If landscape, the transform must rotate explicitly.

- [ ] **Step 4: Decide go / no-go**

- **Both HEVC codecs unsupported AND `createImageBitmap` fails** → STOP. Report to the human. The feature cannot serve its main use case; the spec's §10 says reconsider rather than invest further.
- **`createImageBitmap` works** → GO, and note the orientation for Task 3. A `<video>` + `createImageBitmap` decode path sidesteps `VideoDecoder` entirely and is likely simpler; prefer it if it works.
- **`VideoDecoder` supported but `createImageBitmap` fails** → GO with the `VideoDecoder` path.

- [ ] **Step 5: Delete the probe**

```bash
rm scratch-webcodecs-probe.html
# also remove it from public/ if you copied it there
```

Nothing is committed from this task. Report the four answers and the decision.

---

### Task 2: Pure geometry and the trigger predicate

**Files:**
- Create: `lib/media/video-geometry.ts`
- Test: `lib/media/video-geometry.test.ts`

**Interfaces:**
- Consumes: `MAX_BYTES` from `lib/storage/constants`
- Produces:
  - `TARGET_WIDTH = 720`, `TRIM_SEC = 16`
  - `type Rotation = 0 | 90 | 180 | 270`
  - `rotatedDimensions(codedWidth, codedHeight, rotation): { width, height }`
  - `scaleToTarget(width, height): { width, height }`
  - `needsWork({ sizeBytes, durationSec, displayWidth }): boolean`

- [ ] **Step 1: Write the failing tests**

```ts
// lib/media/video-geometry.test.ts
import { describe, expect, it } from 'vitest';
import { MAX_BYTES } from '@/lib/storage/constants';
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
    // Any result of 720x405 here means rotation was not applied and the
    // upload would be sideways.
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
    // 1081 is odd and scales to an odd height; both must come back even.
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
    // The server rejects `size > MAX_BYTES`, so the cap itself is allowed;
    // being stricter here than the API would reject files the API accepts.
    expect(needsWork({ sizeBytes: MAX_BYTES, durationSec: TRIM_SEC, displayWidth: TARGET_WIDTH }))
      .toBe(false);
  });

  it('triggers for IMG_1795.MOV', () => {
    // 83309337 bytes, 13.89s, displayed 2160 wide — over on size and width,
    // under on duration. The real motivating case.
    expect(needsWork({ sizeBytes: 83_309_337, durationSec: 13.89, displayWidth: 2160 })).toBe(true);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run lib/media/video-geometry.test.ts`
Expected: FAIL — `Failed to resolve import "./video-geometry"`

- [ ] **Step 3: Write the implementation**

```ts
// lib/media/video-geometry.ts
//
// Pure geometry for client-side upload preparation. No DOM, no codecs, so
// every dimension decision is unit-testable — which matters because the
// failure it guards against is silent: a wrongly-rotated upload produces
// fluent, confident, wrong vision descriptions and raises nothing.

import { MAX_BYTES } from '@/lib/storage/constants';

// The server runs `-vf "fps=0.5,scale=720:-2"`, so anything wider is
// discarded after upload regardless.
export const TARGET_WIDTH = 720;

// The server samples 8 frames at 2s intervals; the last lands at a measured
// t=14.0s. 16s is deliberate margin so keyframe placement or rounding cannot
// cost the eighth frame.
export const TRIM_SEC = 16;

export type Rotation = 0 | 90 | 180 | 270;

// Phone video is routinely stored as a landscape frame plus a rotation flag.
// IMG_1795.MOV is coded 3840x2160 with "rotation of -90.00 degrees" and
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

// Skip the decode/encode entirely when it cannot help. Boundaries are
// inclusive-pass on purpose: the API rejects `size > MAX_BYTES`, so treating
// the cap itself as needing work would be stricter than the gate it feeds.
export function needsWork(o: {
  sizeBytes: number;
  durationSec: number;
  displayWidth: number;
}): boolean {
  return o.sizeBytes > MAX_BYTES || o.durationSec > TRIM_SEC || o.displayWidth > TARGET_WIDTH;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run lib/media/video-geometry.test.ts`
Expected: PASS, 15 tests

- [ ] **Step 5: Run the full suite and typecheck**

Run: `npm test && npm run typecheck`
Expected: all passing, typecheck clean

Note: this file imports via the `@/` alias, which is correct — it is app code under `lib/`, not a standalone tsx script.

- [ ] **Step 6: Commit**

```bash
git add lib/media/video-geometry.ts lib/media/video-geometry.test.ts
git commit -m "Add pure geometry for client-side upload preparation

Rotation resolution is the load-bearing part: IMG_1795.MOV is coded
3840x2160 with a -90 degree display matrix, and the server's
scale=720:-2 was measured to produce 720x1280. A test pins that
reference, because producing 720x405 instead would upload a sideways
video and the vision model would describe it without complaint."
```

---

### Task 3: The transform

**Files:**
- Create: `lib/media/prepare-upload.ts`
- Modify: `package.json` (add `mp4-muxer`)

**Interfaces:**
- Consumes: `TARGET_WIDTH`, `TRIM_SEC`, `scaleToTarget`, `needsWork` from `./video-geometry`
- Produces: `prepareUpload(file: File): Promise<File>`

Use the decode path Task 1 identified. The code below uses `<video>` + `createImageBitmap`, which Task 1 tests first because it is simpler and applies rotation for free. If Task 1 found that path unavailable, substitute `VideoDecoder` for the frame source and keep everything else — including the orientation assertion.

- [ ] **Step 1: Add the muxer dependency**

```bash
npm install mp4-muxer@5.2.2
```

- [ ] **Step 2: Write the module**

```ts
// lib/media/prepare-upload.ts
//
// Shrink a selected clip in the browser before upload.
//
// The server samples 8 frames (last at a measured t=14.0s) at 720px wide and
// never reads audio, so trimming to 16s, scaling to 720px and dropping audio
// lose nothing it consumes. An 83MB 4K clip becomes a couple of MB.
//
// CONTRACT: this function never throws and never blocks an upload. Every
// failure path returns the input file, which then meets the same
// rejectUpload() gate it meets today. The feature can only help.

'use client';

import { Muxer, ArrayBufferTarget } from 'mp4-muxer';
import { TARGET_WIDTH, TRIM_SEC, scaleToTarget, needsWork } from './video-geometry';

const FPS = 30;
const BITRATE = 2_000_000; // 2 Mbps at 720p is ample for 8 sampled stills.

async function loadMetadata(file: File): Promise<{ video: HTMLVideoElement; url: string }> {
  const url = URL.createObjectURL(file);
  const video = document.createElement('video');
  video.preload = 'auto';
  video.muted = true;
  video.playsInline = true;
  video.src = url;
  await new Promise<void>((resolve, reject) => {
    video.onloadedmetadata = () => resolve();
    video.onerror = () => reject(new Error('could not read video metadata'));
  });
  return { video, url };
}

function seek(video: HTMLVideoElement, t: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const done = () => { video.removeEventListener('seeked', done); resolve(); };
    video.addEventListener('seeked', done);
    video.onerror = () => reject(new Error('seek failed'));
    video.currentTime = t;
  });
}

export async function prepareUpload(file: File): Promise<File> {
  if (typeof window === 'undefined') return file;
  if (!('VideoEncoder' in window)) return file;

  let url: string | null = null;
  try {
    const meta = await loadMetadata(file);
    const video = meta.video;
    url = meta.url;

    // videoWidth/videoHeight are DISPLAY dimensions — the browser has already
    // applied the rotation matrix, so portrait phone footage reports portrait
    // here even though it is coded landscape.
    const displayWidth = video.videoWidth;
    const displayHeight = video.videoHeight;
    const durationSec = video.duration;

    if (!displayWidth || !displayHeight || !Number.isFinite(durationSec)) return file;
    if (!needsWork({ sizeBytes: file.size, durationSec, displayWidth })) return file;

    const out = scaleToTarget(displayWidth, displayHeight);

    // ORIENTATION ASSERTION. The spec's highest-severity risk is uploading a
    // sideways video, which produces confident, wrong descriptions and raises
    // nothing. Bail rather than ship a frame whose aspect disagrees with what
    // the element reported.
    const srcPortrait = displayHeight > displayWidth;
    const outPortrait = out.height > out.width;
    if (srcPortrait !== outPortrait) return file;

    const support = await VideoEncoder.isConfigSupported({
      codec: 'avc1.42001f',
      width: out.width,
      height: out.height,
      bitrate: BITRATE,
      framerate: FPS,
    });
    if (!support.supported) return file;

    const target = new ArrayBufferTarget();
    const muxer = new Muxer({
      target,
      video: { codec: 'avc', width: out.width, height: out.height },
      fastStart: 'in-memory',
    });

    const encoder = new VideoEncoder({
      output: (chunk, m) => muxer.addVideoChunk(chunk, m),
      error: () => { /* surfaced by the await below */ },
    });
    encoder.configure({
      codec: 'avc1.42001f',
      width: out.width,
      height: out.height,
      bitrate: BITRATE,
      framerate: FPS,
    });

    const canvas = new OffscreenCanvas(out.width, out.height);
    const ctx = canvas.getContext('2d');
    if (!ctx) return file;

    const endSec = Math.min(durationSec, TRIM_SEC);
    const frameCount = Math.max(1, Math.floor(endSec * FPS));

    for (let i = 0; i < frameCount; i++) {
      const t = i / FPS;
      await seek(video, t);
      const bitmap = await createImageBitmap(video);
      ctx.drawImage(bitmap, 0, 0, out.width, out.height);
      bitmap.close();
      const frame = new VideoFrame(canvas, {
        timestamp: Math.round(t * 1_000_000), // microseconds
        duration: Math.round(1_000_000 / FPS),
      });
      encoder.encode(frame, { keyFrame: i % (FPS * 2) === 0 });
      frame.close();
    }

    await encoder.flush();
    encoder.close();
    muxer.finalize();

    const blob = new Blob([target.buffer], { type: 'video/mp4' });

    // A transform that made things bigger is a transform not worth keeping.
    if (blob.size >= file.size) return file;

    const name = file.name.replace(/\.[^.]+$/, '') + '-prepared.mp4';
    return new File([blob], name, { type: 'video/mp4' });
  } catch {
    // Unsupported codec, decode failure, OOM — all identical from the caller's
    // point of view: nothing was prepared, use what the user picked.
    return file;
  } finally {
    if (url) URL.revokeObjectURL(url);
  }
}
```

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: clean. If `VideoFrame`/`VideoEncoder`/`OffscreenCanvas` types are missing, add `"dom"` and `"dom.iterable"` to `compilerOptions.lib` in `tsconfig.json` — do not add `any` casts.

- [ ] **Step 4: Confirm the suite still passes**

Run: `npm test`
Expected: unchanged count, all passing. This module has no unit tests by design — it is browser-only and is verified in Task 5.

- [ ] **Step 5: Commit**

```bash
git add lib/media/prepare-upload.ts package.json package-lock.json
git commit -m "Add browser-side trim, downscale and audio strip before upload

Never throws: unsupported codec, decode failure or a transform that
grew the file all return the original, which then meets the same
rejectUpload() gate as today.

Asserts source and output agree on portrait-vs-landscape before
encoding. Uploading a sideways clip is the one failure here that
raises nothing and still corrupts every title generated from it."
```

---

### Task 4: Wire it into the dropzone

**Files:**
- Modify: `components/app/upload-dropzone.tsx`

**Interfaces:**
- Consumes: `prepareUpload` from `@/lib/media/prepare-upload`; the existing `rejectUpload` from `@/lib/storage/constants`
- Produces: nothing new

- [ ] **Step 1: Make `accept` async and add a preparing state**

In `components/app/upload-dropzone.tsx`, add to the imports:

```ts
import { prepareUpload } from '@/lib/media/prepare-upload';
```

Add a state hook beside `dragOver`:

```ts
const [preparing, setPreparing] = useState(false);
```

Replace the existing `accept` callback with:

```ts
  // Order matters: prepare first, then gate. A 79MB 4K clip becomes a couple
  // of MB and passes a check it would otherwise fail, and a file that cannot
  // be prepared arrives at exactly the same gate it meets today.
  const accept = useCallback(
    async (f: File) => {
      setPreparing(true);
      let candidate = f;
      try {
        candidate = await prepareUpload(f);
      } finally {
        setPreparing(false);
      }
      const problem = rejectUpload(candidate.size, candidate.type);
      if (problem) {
        toast.error(problem);
        return;
      }
      onFile(candidate);
    },
    [onFile],
  );
```

- [ ] **Step 2: Show the preparing state**

Treat `preparing` like `busy` for interaction, and give it its own label. Change the `whileHover`, `onClick`, `onDragOver` and `className` guards from `busy` to `busy || preparing`, and replace the caption paragraph with:

```tsx
      <p className="text-micro uppercase tracking-[0.12em] text-ink-muted">
        {preparing ? 'preparing clip…' : 'mp4 or mov · ≤ 50 mb · up to 60s at 1080p'}
      </p>
```

Leave the `<input disabled={busy}>` as it is — `preparing` already blocks the click that opens it.

- [ ] **Step 3: Typecheck and build**

Run: `npm run typecheck && npm run build`
Expected: both clean

- [ ] **Step 4: Confirm the suite still passes**

Run: `npm test`
Expected: unchanged count, all passing

- [ ] **Step 5: Commit**

```bash
git add components/app/upload-dropzone.tsx
git commit -m "Prepare clips before the upload gate, not after

A 79MB 4K clip now shrinks and passes; one that cannot be prepared
meets the same rejection message it does today."
```

---

### Task 5: Browser verification

**Files:** none — this task produces evidence, not code.

The transform is browser-only, so this is where it is actually proven. **Do not skip or simulate any of these. Report what you observe, including failures.**

- [ ] **Step 1: Start the app**

```bash
npm run dev
```

Open `http://localhost:3000`, log in with the `APP_PASSCODE` from `.env.local`.

- [ ] **Step 2: The real case — `IMG_1795.MOV`**

Drop in `C:\Users\essam\Downloads\IMG_1795.MOV` (83,309,337 bytes, HEVC, 13.89s, portrait).

Record:
- Does "preparing clip…" appear, and for how long?
- Does the upload proceed, or does the rejection toast appear?
- In DevTools → Network, what is the size of the body PUT to Supabase?

Expected: a few MB uploaded instead of 79.4 MB. If instead the rejection toast appears, the transform bailed — check the console and report which branch returned early.

- [ ] **Step 3: THE ORIENTATION CHECK — the one that matters**

After generating, open the generation's `vision_description` (via the history modal, or query `generations` in Supabase).

Read it and answer plainly: **does it describe a portrait video of the actual subject, or does it read as though the scene is sideways?**

A rotated upload does not error. It produces fluent, confident, wrong descriptions. This is the only check that catches it. If the description seems to be of a rotated scene, stop and report — do not proceed.

- [ ] **Step 4: Trim behaviour**

Upload an H.264 clip longer than 16 seconds — `datasets/raw/aligordon/videos/DbNhQGLu4sr.mp4` is 27.8s.

Confirm it uploads, and that the uploaded size is smaller than the source. The generated titles should be about the first ~14 seconds, which is unchanged behaviour.

- [ ] **Step 5: Pass-through**

Upload the already-small `C:\Users\essam\Downloads\IMG_1795_1080p.mp4` (2,832,518 bytes, 1080p, 13.9s).

`needsWork` should return true on width (1080 > 720), so it will still be transformed. Confirm it uploads and works. Then confirm a genuinely small clip — under 720px wide, under 16s, under the cap — passes through with no "preparing" delay.

- [ ] **Step 6: Fallback**

Confirm that a file the transform cannot handle still reaches the old rejection path. If HEVC decode failed in Task 1, `IMG_1795.MOV` itself is that case and Step 2 already demonstrated it.

- [ ] **Step 7: Report**

Write up: which files were transformed, the before/after sizes, the orientation verdict from Step 3 verbatim, and anything that fell back. Do not claim success on any step you did not actually observe in the browser.

---

## Self-Review

**Spec coverage:**

| Spec section | Task |
|---|---|
| §4 WebCodecs / Chrome-only decision | 1, 3 |
| §4b silent fallback | 3 (every `return file` path) |
| §5 trim / scale / drop audio / H.264 MP4 | 2 (geometry), 3 (pipeline) |
| §5a rotation, the highest risk | 1 (probe), 2 (`rotatedDimensions` + pinned reference), 3 (assertion), 5 (Step 3) |
| §6 trigger conditions | 2 (`needsWork`) |
| §7 architecture and data flow | 2, 3, 4 |
| §7 preview unchanged | Nothing touches `app/(app)/page.tsx` — enforced by omission |
| §7 `rejectUpload` stays authoritative | 4 (gate runs after preparation) |
| §8 consequences | Documented in the spec; no code change required |
| §9 unit tests | 2 |
| §9 manual browser tests | 5 |
| §9 re-encode asymmetry check | 5 Step 3 reads the description, which is the same evidence |
| §10 HEVC risk | 1 (front-loaded so failure costs one task, not five) |

No gaps.

**Placeholder scan:** none. Every step carries the code or the exact command.

**Type consistency:** `TARGET_WIDTH`, `TRIM_SEC`, `scaleToTarget`, `needsWork` are defined in Task 2 and consumed in Task 3 with matching signatures. `rotatedDimensions` is used in Task 2's tests to derive the reference and is exported for Task 3's use if the `VideoDecoder` path is taken. `prepareUpload(file: File): Promise<File>` is defined in Task 3 and consumed in Task 4. `rejectUpload(size, mime)` matches the existing signature in `lib/storage/constants.ts`.

**One thing the implementer should know:** Task 3's frame loop seeks and grabs a bitmap per frame at 30fps, so a 16-second clip performs ~480 seek-and-decode round trips. This is the simple, correct-first version. If Step 2 of Task 5 shows it taking more than about 30 seconds, say so in the report rather than silently accepting it — the fix is to lower `FPS` (the server samples at 0.5fps, so even 10fps would lose nothing it consumes), and that is a one-line change.
