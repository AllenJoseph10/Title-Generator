# Client-Side Upload Preparation — Design

**Date:** 2026-08-04
**Status:** Approved design, ready for implementation planning
**Scope:** Trim and downscale a selected video in the browser before upload, so ordinary phone footage fits the 50 MB storage cap without the user having to transcode anything by hand.

---

## 1. Problem

A 13.89-second clip straight off an iPhone — 3840×2160, 59.96 fps, HEVC, ~48 Mbps — is **83,309,337 bytes**. The upload cap is **52,428,800**. It is rejected.

That is not an edge case. At 4K/60 bitrates, 50 MB arrives in roughly **8 seconds** of footage, while the app advertises clips "up to 60s". The size limit binds about 7× sooner than the duration limit, so a user shooting at their phone's default settings can rarely upload anything usable.

The cap itself is not movable from the app. `MAX_BYTES` mirrors the `uploads` bucket's own `file_size_limit` (52428800); raising the constant alone would convert a clean client-side rejection into a mid-upload storage failure. Whether the bucket limit can be raised depends on a Supabase plan tier that is not known and cannot be read with the project's service-role key.

### The waste that makes this tractable

The server downloads the uploaded object and calls:

```ts
extractFrames(input.videoBytes, TARGET_FRAMES)   // TARGET_FRAMES = 8, no options
```

which defaults to `intervalSec = 2` and runs `-vf "fps=0.5,scale=720:-2" -frames:v 8`.

Measured `pts_time` of the eight frames it returns, on a real 27.8s clip:

```
0, 2, 4, 6, 8, 10, 12, 14
```

So the pipeline reads **eight instants, the last at exactly 14.0 seconds, each rendered at 720px wide, with no audio**. Everything else in the file — every frame after 14.0s, every pixel of resolution above 720px, the entire audio track — is transferred, stored, and discarded.

Uploading 83 MB to sample eight 720px stills is about 99% waste. Removing that waste is enough to solve the problem without touching the cap.

### Note on "16 seconds"

Existing project notes describe a "16-second coverage limit". That is the coverage *window* if each sample is treated as representing its 2-second interval. The stricter and more accurate statement is that **no frame is captured after t = 14.0s**. A title card appearing at 14.5s and gone by 15.9s sits inside the "16-second window" and is never seen. This spec trims at 16s anyway — see §5.

---

## 2. Goals

- Ordinary phone clips upload successfully without manual transcoding.
- No information the pipeline actually consumes is lost.
- No new way for an upload to fail. Any file that succeeds today still succeeds.
- No change to Supabase configuration, since the plan tier is unknown.
- The user's preview and burn-in experience is unchanged.

## 3. Non-goals

- **Raising `MAX_BYTES` or the bucket limit.** Treats the symptom; a 60s 4K clip would still be ~360 MB.
- **Changing what the pipeline analyses.** The 14-second blind spot is a separate question with a real cost (re-describing all 175 corpus rows). Out of scope; see §10.
- **Supporting Safari or Firefox.** Chrome/Edge only, by decision. See §4.
- **Server-side transcoding.** Would still require the oversized upload to complete first, which is the thing being avoided.
- **Progress reporting beyond a busy state.** YAGNI for a tool with one or two users.

---

## 4. Decisions

| Decision | Choice | Why |
|---|---|---|
| Where the transform runs | Browser, before upload | Server-side cannot help; the upload is what must shrink |
| Browser support | Chrome/Edge (WebCodecs) | Outputs H.264/MP4, so no mime or bucket changes; faster than real time |
| On decode failure | Return the original file silently | Guarantees the feature is a pure improvement with no new failure mode |
| Output container | MP4 (`video/mp4`) | Already in `ACCEPTED_MIME` and the bucket's `allowed_mime_types` |
| Trim point | 16s | Safety margin over the 14.0s last sample; see §5 |

### 4a. Why not MediaRecorder or ffmpeg.wasm

**MediaRecorder + canvas** is near-universal but captures in real time (a 16s clip costs 16s of wall-clock), loses more quality, and emits **WebM** in Chrome — which is in neither `ACCEPTED_MIME` nor the bucket's `allowed_mime_types`, so it would force a Supabase config change of exactly the kind §2 rules out.

**ffmpeg.wasm** would run the identical filters the server uses, in any browser, with no format surprises — but it ships a ~25–30 MB WASM bundle to every visitor. Disproportionate for an internal tool.

### 4b. Why silent fallback rather than an explanatory error

Chrome's WebCodecs **HEVC decode support is conditional** on platform and hardware. The files most needing this feature — iPhone 4K clips — are exactly the ones most likely to fail to decode. A design that surfaces a codec error to the user turns a working-today path into a confusing dead end.

Returning the original file on any failure means the worst case is precisely today's behaviour: under the cap it uploads; over it, `rejectUpload()` produces the actionable message that already exists. The feature can only help.

---

## 5. The transform

Applied in order:

1. **Apply the source's rotation metadata before anything else.** See §5a — this is the highest-risk requirement in the spec.
2. **Trim to the first 16 seconds.** The last sampled frame is at 14.0s, so 16s is a two-second margin absorbing keyframe placement and rounding. Trimming at 14s risks losing the eighth frame to an off-by-one; the extra two seconds cost almost nothing.
3. **Scale to 720px wide** *of the rotated frame*, preserving aspect ratio, rounding height to an even number. `extractFrames` already applies `scale=720:-2`, so anything wider is discarded server-side regardless.
4. **Drop audio entirely.** This is a silent-video product; no code path reads audio.
5. **Encode H.264, mux to MP4.**

### 5a. Rotation — the silent-failure risk

`IMG_1795.MOV` reports `3840x2160` as its coded size, and also carries:

```
displaymatrix: rotation of -90.00 degrees
```

It is a **portrait** video stored as a landscape frame plus a rotation flag — the norm for phone footage. ffmpeg applies the display matrix automatically inside its filter chain, so the server's `scale=720:-2` yields **720×1280**, measured, not 720×405 as the coded dimensions would suggest.

A browser decoder hands back frames in **coded** orientation. If the transform draws them to canvas without applying the rotation, and then writes a fresh MP4 (which carries no rotation flag, because the rotation has notionally been "baked in" — except it hasn't), the result is a **sideways 720×405 landscape video**. The server would then extract eight rotated frames and hand them to the vision model.

**This fails silently and expensively.** No error is raised, the upload succeeds, the pipeline runs, and the model returns confident, fluent descriptions of a scene it is viewing at 90°. The titles would be plausible and wrong, and nothing downstream could detect it.

The implementation must therefore:
- Read the source rotation (via the `<video>` element's applied dimensions, the container's display matrix, or `VideoFrame.displayWidth`/`displayHeight` — whichever proves reliable) and apply it when drawing to canvas.
- **Assert the output orientation matches what ffmpeg would produce**, rather than assuming. The check is concrete: transformed portrait footage must come out taller than it is wide.

Given the cost of getting this wrong, an implementation that cannot reliably determine rotation should fall back to returning the original file (§4b) rather than guess.

### Why this is lossless for the pipeline

For a clip longer than 16s, `fps=0.5` over the trimmed file yields frames at 0, 2, …, 14 — the same eight instants as the untrimmed original. For a clip at or under 16s, no trim occurs. Resolution above 720px and audio are discarded by the server anyway.

### The one real loss, stated plainly

Re-encoding adds **a second generation of lossy compression**. The frames the vision model sees are therefore not bit-identical to those it would have seen from the original — H.264 at the chosen quality, then ffmpeg's `scale=720:-2`, rather than the source codec then the same scale.

This matters more here than it would elsewhere. The corpus's 175 `visual_description` rows were generated from **original** downloaded files, and retrieval depends on corpus and query descriptions occupying the same embedding space — a mismatch of exactly this kind is what made retrieval near-random before migration 0003.

The effect is expected to be negligible: both paths converge on a 720px-wide JPEG, and the vision prompt describes scene content rather than fine texture. But it is a real asymmetry introduced by this change, and it should be checked once rather than assumed. See §9.

---

## 6. When the transform runs

Skip the work whenever it cannot help. Transform only if **any** of:

- `file.size > MAX_BYTES`
- duration > 16s
- video width > 720px

A 3 MB 720p clip passes through untouched, with no decode, no encode, and no added latency.

This predicate is pure and testable; the duration and width come from a lightweight metadata probe on a `<video>` element before any decoding begins.

---

## 7. Architecture

One new client-side module. Everything else is wiring.

| File | Responsibility |
|---|---|
| `lib/media/prepare-upload.ts` | **New.** `prepareUpload(file): Promise<File>` — probe, decide, transform, or return the original |
| `lib/media/prepare-upload.test.ts` | **New.** Unit tests for the pure parts |
| `components/app/upload-dropzone.tsx` | **Modified.** Await `prepareUpload` before `rejectUpload`; show a busy state |
| `package.json` | **Modified.** One dependency: an MP4 muxer |

### Data flow

```
File
 └─► prepareUpload(file)
       ├─ needsWork(size, duration, width)? ──no──► original File
       ├─ VideoDecoder.isConfigSupported()? ──no──► original File
       ├─ decode → OffscreenCanvas @720w → VideoEncoder(H.264) → MP4 mux
       │     └─ any throw ─────────────────────────► original File
       └─► transformed File (video/mp4)
             │
             ▼
       rejectUpload(size, mime)   ← unchanged gate, still authoritative
             │
             ▼
       existing upload path, unchanged
```

`prepareUpload` **never rejects**. Its failure mode is returning its input.

### What deliberately does not change

- **The preview.** `page.tsx:71` builds `URL.createObjectURL(file)` from the **original** File. The user watches and burn-in-previews their untouched clip; only the bytes bound for Supabase are transformed. These are already independent, which is what makes this safe.
- **`rejectUpload()` stays the authoritative gate**, on both client and server. A transform that fails still meets the same check it does today.
- **`ACCEPTED_MIME`, the bucket's `allowed_mime_types`, `MAX_BYTES`, and the bucket's `file_size_limit`** are all untouched.

---

## 8. Consequences to be aware of

1. **`MAX_DURATION_SEC` becomes unreachable for transformed files.** The orchestrator rejects clips over 60s; every transformed upload is ≤16s, so that check can only fire for pass-through files. It stays as a guard, but it will effectively never trigger once this ships.
2. **Stored duration metadata changes meaning.** A generation created from a trimmed upload records the trimmed video, not the source. Anything downstream reading duration from the stored object sees 16s, not the original length. No current consumer is known to do this; the implementation must confirm rather than assume.
3. **The 14-second blind spot is unchanged.** This spec makes the upload match what is analysed. It does not widen what is analysed. A user uploading a 60s video still gets titles generated from its first 14 seconds — and now the stored artefact makes that limitation visible rather than hiding it behind a full-length file.

---

## 9. Testing

**Unit (vitest, alongside the existing `lib/storage/constants.test.ts`):**
- `needsWork()` — each trigger independently, and the skip case where none apply
- Scale maths, expressed against the **rotated** frame, since that is what the server scales. Measured reference: `IMG_1795.MOV`, coded 3840×2160 with a −90° display matrix, produces **720×1280** under the server's `scale=720:-2`. Cover a landscape source with no rotation flag, a portrait source carrying one, and a source already ≤720px wide (left alone).
- Rotation resolution — given coded dimensions and a rotation value, the function returns the correct output dimensions. Table-driven over 0°, ±90°, 180°.

**Manual, in the browser** — the codec pipeline cannot be unit-tested without one:
- The real `IMG_1795.MOV` (83 MB, HEVC, 13.9s). This is simultaneously the feature's main use case and the test of whether HEVC decode works at all on this machine.
- An H.264 clip over 16s, confirming the trim.
- A small 720p clip, confirming it passes through untransformed.
- A deliberately unsupported file, confirming silent fallback to `rejectUpload()`.

**One-off check of the §5 asymmetry:** run the same clip through the pipeline twice — once as the original, once transformed — and compare the two `visual_description` outputs. They should describe the same scene. This is a sanity check performed once, not an automated test.

---

## 10. Risks

| Risk | Handling |
|---|---|
| **Rotation applied wrongly — the worst failure in this spec.** A sideways upload produces confident, fluent, wrong descriptions with no error anywhere. | §5a. Assert output orientation rather than assume it; fall back to the original file if rotation cannot be determined reliably. Verify against the measured 720×1280 reference before trusting any other test. |
| **HEVC decode unsupported in Chrome on this machine.** The primary use case fails. | Silent fallback (§4b) means no regression, but the feature would deliver little. The manual test with the real file settles it early — if it fails, reconsider before investing further. |
| Re-encode shifts query descriptions relative to corpus descriptions | §5; checked once per §9. Expected negligible since both converge on a 720px JPEG. |
| New dependency (MP4 muxer) | Small, single-purpose, client-side only. |
| Encode latency on large 4K files | Busy state in the dropzone. WebCodecs is faster than real time; if it proves slow, lowering the encode quality target is a one-line change. |

## 11. Out of scope

- Widening the pipeline's 14-second analysis window (would require re-describing all 175 corpus rows)
- Safari and Firefox support
- Raising either size limit
- Server-side transcoding
- Progress percentage during encode
