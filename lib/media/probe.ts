import { spawn } from 'node:child_process';
import ffmpegPath from 'ffmpeg-static';

export type ProbeResult = {
  durationSec: number;
  hasVideoStream: boolean;
};

// Uses `ffmpeg -i` (not ffprobe) to read container metadata from stdin.
// ffmpeg-static does not ship ffprobe; the duration line in ffmpeg's stderr is reliable.

export async function probeVideo(input: Buffer): Promise<ProbeResult> {
  if (!ffmpegPath) throw new Error('ffmpeg-static did not resolve a binary path');

  const proc = spawn(ffmpegPath, ['-hide_banner', '-i', 'pipe:0', '-f', 'null', '-'], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const stderrChunks: Buffer[] = [];
  proc.stderr.on('data', (c: Buffer) => stderrChunks.push(c));
  proc.stdin.end(input);
  await new Promise<void>((resolve) => proc.on('close', () => resolve()));

  const stderr = Buffer.concat(stderrChunks).toString('utf8');
  const durMatch = stderr.match(/Duration:\s*(\d+):(\d+):([\d.]+)/);
  if (!durMatch) {
    throw new Error(`probe: no Duration line in ffmpeg output: ${stderr.slice(0, 400)}`);
  }
  const h = parseInt(durMatch[1], 10);
  const m = parseInt(durMatch[2], 10);
  const s = parseFloat(durMatch[3]);
  const durationSec = h * 3600 + m * 60 + s;

  const hasVideoStream = /Stream\s*#\d+:\d+(?:\[[^\]]+\])?(?:\([^)]*\))?:\s*Video/.test(stderr);

  return { durationSec, hasVideoStream };
}
