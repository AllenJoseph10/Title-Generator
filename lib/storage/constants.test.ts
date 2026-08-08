import { describe, expect, it } from 'vitest';
import { MAX_BYTES, formatMb, rejectUpload } from './constants';

describe('formatMb', () => {
  it('renders MiB to one decimal', () => {
    // 83309337 / 1048576 = 79.4499..., so this rounds down, not up.
    expect(formatMb(83_309_337)).toBe('79.4 MB');
  });

  it('renders the cap itself as a round number', () => {
    expect(formatMb(MAX_BYTES)).toBe('50 MB');
  });

  it('does not print a trailing .0', () => {
    expect(formatMb(10 * 1024 * 1024)).toBe('10 MB');
  });
});

describe('rejectUpload', () => {
  it('accepts an in-range mp4', () => {
    expect(rejectUpload(10 * 1024 * 1024, 'video/mp4')).toBeNull();
  });

  it('accepts an in-range mov', () => {
    expect(rejectUpload(10 * 1024 * 1024, 'video/quicktime')).toBeNull();
  });

  it('accepts a file exactly at the cap', () => {
    // The server check is `size > MAX_BYTES`, so the boundary is allowed.
    // Rejecting it here would make the client stricter than the API.
    expect(rejectUpload(MAX_BYTES, 'video/mp4')).toBeNull();
  });

  it('rejects one byte over the cap', () => {
    expect(rejectUpload(MAX_BYTES + 1, 'video/mp4')).not.toBeNull();
  });

  it('names both the actual size and the limit, so the message is actionable', () => {
    // The bug this replaces surfaced as "size out of range: 83309337" — a raw
    // byte count with no limit, no units and no way for a user to act on it.
    const msg = rejectUpload(83_309_337, 'video/quicktime');
    expect(msg).toContain('79.4 MB');
    expect(msg).toContain('50 MB');
  });

  it('tells the user what to do about it', () => {
    // 4K/60 phone footage busts 50 MB in ~8s, so "shoot smaller" is the fix
    // a user can actually apply — not "try a shorter clip".
    expect(rejectUpload(83_309_337, 'video/quicktime')).toMatch(/1080p|trim/i);
  });

  it('rejects an unsupported mime', () => {
    expect(rejectUpload(1000, 'video/webm')).toContain('MP4');
  });

  it('rejects an empty file', () => {
    expect(rejectUpload(0, 'video/mp4')).not.toBeNull();
  });

  it('checks the mime before the size, so a huge webm is not called too large', () => {
    expect(rejectUpload(999_999_999, 'video/webm')).toContain('MP4');
  });
});
