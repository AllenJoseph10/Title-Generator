// Tags an error as having potentially reached — and been billed by — the
// provider, distinct from a purely local failure (missing file, ffmpeg
// error) that never made a network call.
//
// Both lib/providers/anthropic/burned-in-title.ts and
// lib/providers/anthropic/vision.ts throw when a billed HTTP 200 response
// contains no tool_use block: the request was charged, but costUsd is never
// computed because the throw happens before the cost calculation. Wrapping
// the provider call site in the calling script lets the script count these
// separately from ordinary failures, so the final report can say "N calls
// may have been billed but are not reflected in the cost total" instead of
// silently under-reporting spend.
export class ProviderCallFailure extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProviderCallFailure';
  }
}
