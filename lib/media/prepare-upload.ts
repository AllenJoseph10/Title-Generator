'use client';

// Shrink a selected clip in the browser before upload.
//
// The server samples 8 frames — the last at a measured t=14.0s — at 720px wide
// and never reads audio, so trimming to 16s, scaling to 720px and dropping
// audio lose nothing it consumes. An 83MB 4K clip becomes a couple of MB.
//
// CONTRACT: this function never throws and never blocks an upload. Every
// failure path returns the input file, which then meets the same
// rejectUpload() gate it meets today. The feature can only help.

import { Muxer, ArrayBufferTarget } from 'mp4-muxer';
import { TRIM_SEC, scaleToTarget, needsWork } from './video-geometry';

// The server samples at 0.5fps, so it can only ever see 8 of these frames.
// 15fps is far more than it consumes while keeping the encode short — a 16s
// clip is 240 frames rather than 480.
//
// MEASURED 2026-08-09, on a 1080x1920 22s clip: dropping this to 8 (240 seeks
// -> 128) changed preparation from 10.94s to 10.47s. Frame count is NOT the
// bottleneck — each seek forces a decode forward from the previous keyframe, so
// total decode work tracks the clip's duration rather than how many frames are
// sampled from it. Lowering FPS only costs preview smoothness. Do not "optimise"
// this number again without measuring.
const FPS = 15;
const BITRATE = 2_000_000; // 2 Mbps at 720p is ample for 8 sampled stills.
const CODEC = 'avc1.42001f'; // H.264 baseline, level 3.1.
const SEEK_TIMEOUT_MS = 10_000;

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`${what} timed out`)), ms)),
  ]);
}

function loadMetadata(video: HTMLVideoElement): Promise<void> {
  return withTimeout(
    new Promise<void>((resolve, reject) => {
      video.onloadedmetadata = () => resolve();
      video.onerror = () => reject(new Error('could not read video metadata'));
    }),
    SEEK_TIMEOUT_MS,
    'metadata load',
  );
}

function seek(video: HTMLVideoElement, t: number): Promise<void> {
  return withTimeout(
    new Promise<void>((resolve, reject) => {
      const done = () => {
        video.removeEventListener('seeked', done);
        resolve();
      };
      video.addEventListener('seeked', done);
      video.onerror = () => reject(new Error('seek failed'));
      video.currentTime = t;
    }),
    SEEK_TIMEOUT_MS,
    'seek',
  );
}

export async function prepareUpload(file: File): Promise<File> {
  if (typeof window === 'undefined') return file;
  if (!('VideoEncoder' in window) || !('OffscreenCanvas' in window)) return file;

  let url: string | null = null;
  let video: HTMLVideoElement | null = null;

  try {
    url = URL.createObjectURL(file);
    video = document.createElement('video');
    video.preload = 'auto';
    video.muted = true;
    video.playsInline = true;
    video.src = url;
    await loadMetadata(video);

    // videoWidth/videoHeight are DISPLAY dimensions — the browser has already
    // applied the rotation matrix, so portrait phone footage reports portrait
    // here even though it is coded landscape. This is why the canvas path can
    // draw the frame directly rather than rotating it by hand.
    const displayWidth = video.videoWidth;
    const displayHeight = video.videoHeight;
    const durationSec = video.duration;

    if (!displayWidth || !displayHeight || !Number.isFinite(durationSec)) return file;
    if (!needsWork({ sizeBytes: file.size, durationSec, displayWidth })) return file;

    const out = scaleToTarget(displayWidth, displayHeight);

    // ORIENTATION ASSERTION. Uploading a sideways clip is the one failure here
    // that raises nothing and still corrupts every title generated from it.
    // Bail rather than ship a frame whose aspect disagrees with the source.
    if (displayHeight > displayWidth !== out.height > out.width) return file;

    const support = await VideoEncoder.isConfigSupported({
      codec: CODEC,
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

    let encoderError: Error | null = null;
    const encoder = new VideoEncoder({
      output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
      error: (e) => {
        encoderError = e instanceof Error ? e : new Error(String(e));
      },
    });
    encoder.configure({
      codec: CODEC,
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
      if (encoderError) throw encoderError;
      const t = i / FPS;
      await seek(video, t);
      const bitmap = await createImageBitmap(video);
      ctx.drawImage(bitmap, 0, 0, out.width, out.height);
      bitmap.close();
      const frame = new VideoFrame(canvas, {
        timestamp: Math.round(t * 1_000_000), // microseconds
        duration: Math.round(1_000_000 / FPS),
      });
      // A keyframe every 2 seconds keeps the server's 2s-interval sampling
      // cheap to seek.
      encoder.encode(frame, { keyFrame: i % (FPS * 2) === 0 });
      frame.close();
    }

    await encoder.flush();
    encoder.close();
    if (encoderError) throw encoderError;
    muxer.finalize();

    const blob = new Blob([target.buffer], { type: 'video/mp4' });

    // A transform that made the file bigger is not worth keeping.
    if (blob.size >= file.size) return file;

    const name = `${file.name.replace(/\.[^.]+$/, '')}-prepared.mp4`;
    return new File([blob], name, { type: 'video/mp4' });
  } catch {
    // Unsupported codec, decode failure, seek timeout, OOM — all identical
    // from the caller's point of view: nothing was prepared, so use what the
    // user picked and let the existing gate judge it.
    return file;
  } finally {
    if (video) video.src = '';
    if (url) URL.revokeObjectURL(url);
  }
}
