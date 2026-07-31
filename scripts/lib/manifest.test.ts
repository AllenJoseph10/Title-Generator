import { describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadManifest, saveManifest, manifestPath, type ManifestEntry } from './manifest';

const entry = (over: Partial<ManifestEntry> = {}): ManifestEntry => ({
  shortcode: 'ABC123',
  permalink: 'https://www.instagram.com/reel/ABC123/',
  caption: 'a caption',
  views: 1000,
  likes: 10,
  comments: 1,
  postedAt: '2026-01-01',
  durationSec: 12,
  videoUrl: 'https://cdn/x.mp4',
  status: 'scraped',
  ...over,
});

describe('manifest', () => {
  it('returns an empty array when no manifest exists', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mf-'));
    expect(await loadManifest(dir)).toEqual([]);
  });

  it('round-trips entries through save and load', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mf-'));
    const entries = [entry(), entry({ shortcode: 'DEF456', status: 'included' })];
    await saveManifest(dir, entries);
    expect(await loadManifest(dir)).toEqual(entries);
  });

  it('preserves unknown fields written by other stages', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mf-'));
    const withExtra = { ...entry(), burnedInTitle: 'A title', titleFrameRatio: 0.9 };
    await saveManifest(dir, [withExtra]);
    const [loaded] = await loadManifest(dir);
    expect(loaded.burnedInTitle).toBe('A title');
    expect(loaded.titleFrameRatio).toBe(0.9);
  });

  it('builds the manifest path', () => {
    expect(manifestPath('/tmp/x')).toBe(path.join('/tmp/x', 'manifest.json'));
  });
});
