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
