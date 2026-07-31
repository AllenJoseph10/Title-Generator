// Stage 2b — describe each included video, so corpus rows can be retrieved by
// what the video SHOWS rather than by title wording.
// Usage: tsx scripts/describe-videos.ts <handle>
//
// Reuses lib/providers/anthropic/vision.ts unchanged, at the same 8 frames the
// generation orchestrator uses. That is deliberate: retrieval compares this
// description against the description the app generates for an uploaded video,
// and embedding similarity only holds if both sides come from the same prompt,
// the same model, and the same frame sampling.

import fs from 'node:fs/promises';
import path from 'node:path';
import { loadEnvLocal, requireEnv } from './lib/load-env';
import { loadManifest, saveManifest } from './lib/manifest';
import { extractFrames } from '../lib/media/frames';
import { anthropicVision } from '../lib/providers/anthropic/vision';

// Matches TARGET_FRAMES in lib/generation/orchestrator.ts.
const DESCRIBE_FRAMES = 8;

function parseArgs(argv: string[]) {
  const [handle] = argv;
  if (!handle) {
    console.error('Usage: describe-videos <handle>');
    process.exit(1);
  }
  return { handle };
}

async function main() {
  loadEnvLocal();
  requireEnv(['ANTHROPIC_API_KEY']);

  const { handle } = parseArgs(process.argv.slice(2));
  const dir = path.join(process.cwd(), 'datasets', 'raw', handle);
  const manifest = await loadManifest(dir);

  const pending = manifest.filter(
    (e) => e.status === 'included' && e.videoPath && !e.visualDescription,
  );
  console.log(`${pending.length} videos to describe for @${handle}`);

  let totalCost = 0;
  let done = 0;
  let failed = 0;

  for (const entry of pending) {
    try {
      const videoBytes = await fs.readFile(path.join(dir, entry.videoPath!));
      // No options — reproduces the orchestrator's call exactly.
      const jpegs = await extractFrames(videoBytes, DESCRIBE_FRAMES);
      const res = await anthropicVision.describe({ kind: 'frames', jpegs });
      const d = res.description;

      entry.descriptionFields = {
        scene: d.scene,
        subject: d.subject,
        setting: d.setting,
        vibe: d.vibe,
        visualHook: d.visualHook,
      };
      // Byte-for-byte the concatenation orchestrator.ts uses to build queryText.
      entry.visualDescription = `${d.scene} ${d.visualHook}`;
      entry.describeCostUsd = res.costUsd;
      delete entry.describeError;
      totalCost += res.costUsd;
      done++;
      console.log(`  ${entry.shortcode}: ${entry.visualDescription.slice(0, 90)}…`);
    } catch (e) {
      // A failed description must never discard a good title — record and move on.
      entry.describeError = (e as Error).message;
      failed++;
      console.error(`  ${entry.shortcode}: FAILED — ${(e as Error).message}`);
    }
    await saveManifest(dir, manifest);
  }

  console.log(`\nDone. described=${done} failed=${failed} cost=$${totalCost.toFixed(4)}`);
  if (failed > 0) console.log('Re-run this command to retry the failures.');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
