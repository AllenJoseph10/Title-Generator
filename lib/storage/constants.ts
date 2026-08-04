export const BUCKET = 'uploads';
export const MAX_BYTES = 50 * 1024 * 1024;

export const ACCEPTED_MIME = {
  'video/mp4': 'mp4',
  'video/quicktime': 'mov',
} as const satisfies Record<string, string>;

export type AcceptedMime = keyof typeof ACCEPTED_MIME;

export function isAcceptedMime(s: string): s is AcceptedMime {
  return s in ACCEPTED_MIME;
}

export function formatMb(bytes: number): string {
  const mb = Math.round((bytes / (1024 * 1024)) * 10) / 10;
  return `${Number.isInteger(mb) ? mb : mb.toFixed(1)} MB`;
}

// Why a shared helper rather than an inline check in the dropzone: the same
// rejection has to read identically to a user whether it is caught in the
// browser or returned by /api/upload-url, which is callable directly.
//
// MAX_BYTES mirrors the `uploads` bucket's own file_size_limit (52428800).
// Raising it here alone would not raise the ceiling — it would move a clean
// client-side rejection into a mid-upload storage failure.
//
// The guidance matters as much as the number. The app also caps duration at
// 60s, but phone footage at 4K/60 runs ~48 Mbps, so 50 MB is reached in about
// 8 seconds — the size limit binds roughly 7x sooner than the duration limit,
// and "try a shorter clip" is therefore the wrong advice. Shooting at a lower
// resolution is the fix a user can actually apply.
export function rejectUpload(size: number, mime: string): string | null {
  if (!isAcceptedMime(mime)) {
    return 'That file is not a video we can read. Upload an MP4 or MOV.';
  }
  if (size <= 0) return 'That file is empty.';
  if (size > MAX_BYTES) {
    return (
      `That clip is ${formatMb(size)} — the limit is ${formatMb(MAX_BYTES)}. ` +
      `Record at 1080p instead of 4K, or trim it, and try again.`
    );
  }
  return null;
}
