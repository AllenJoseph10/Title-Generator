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

  it('throws, naming the path, when manifest.json contains malformed JSON', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mf-'));
    await fs.writeFile(manifestPath(dir), '{ "not": "valid json"');
    await expect(loadManifest(dir)).rejects.toThrow(manifestPath(dir));
  });

  it('does not swallow a truncated/corrupt file as an empty manifest', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mf-'));
    // Simulates a crash mid-write under the OLD truncate-and-rewrite scheme:
    // the file exists but its contents are cut short.
    await fs.writeFile(manifestPath(dir), '[{"shortcode":"ABC","perma');
    await expect(loadManifest(dir)).rejects.toThrow();
  });

  it('throws (does not silently return []) on a non-ENOENT read error', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mf-'));
    // Make manifest.json a directory instead of a file, so reading it fails
    // with EISDIR rather than ENOENT.
    await fs.mkdir(manifestPath(dir));
    await expect(loadManifest(dir)).rejects.toThrow(manifestPath(dir));
  });

  it('writes atomically: no partial file is ever visible at the target path', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mf-'));
    const entries = [entry(), entry({ shortcode: 'DEF456' })];
    await saveManifest(dir, entries);
    // No leftover temp file after a successful save.
    const files = await fs.readdir(dir);
    expect(files).toEqual(['manifest.json']);
    expect(await loadManifest(dir)).toEqual(entries);
  });

  it('is unaffected by a stale .tmp file left behind by a previous crash', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mf-'));
    const entries = [entry()];
    await saveManifest(dir, entries);
    // Simulate an orphaned temp file from an interrupted previous run.
    await fs.writeFile(path.join(dir, 'manifest.json.99999-stale.tmp'), 'garbage, not json');
    // loadManifest only ever reads manifest.json itself, so the stale temp
    // file must not be picked up or cause an error.
    await expect(loadManifest(dir)).resolves.toEqual(entries);
    // A subsequent save must also succeed and not collide with the stale tmp.
    const more = [...entries, entry({ shortcode: 'GHI789' })];
    await saveManifest(dir, more);
    expect(await loadManifest(dir)).toEqual(more);
  });
});
