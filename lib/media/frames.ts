import { spawn } from 'node:child_process';
import ffmpegPath from 'ffmpeg-static';
import { withTempVideoFile } from './temp-file';

const JPEG_SOI = Buffer.from([0xff, 0xd8]);
const JPEG_EOI = Buffer.from([0xff, 0xd9]);

export type ExtractFramesOptions = {
  // Keep only the top portion of each sampled frame (e.g. 0.5 = top half).
  // Useful for isolating burned-in title overlays from unrelated content lower in frame.
  cropTopFraction?: number;
  // Seconds between sampled frames. Defaults to 2 so existing callers
  // (the generation orchestrator) keep their current behaviour.
  intervalSec?: number;
  // Skip this many seconds before sampling. Used to take a second, disjoint
  // sample of the same clip.
  offsetSec?: number;
};

export async function extractFrames(
  input: Buffer,
  count: number,
  opts: ExtractFramesOptions = {},
): Promise<Buffer[]> {
  if (!ffmpegPath) {
    throw new Error('ffmpeg-static did not resolve a binary path on this platform');
  }
  if (count < 1) throw new Error(`count must be >= 1 (got ${count})`);
  const { cropTopFraction, intervalSec = 2, offsetSec } = opts;
  if (cropTopFraction !== undefined && (cropTopFraction <= 0 || cropTopFraction > 1)) {
    throw new Error(`cropTopFraction must be in (0, 1] (got ${cropTopFraction})`);
  }
  if (intervalSec <= 0) throw new Error(`intervalSec must be > 0 (got ${intervalSec})`);
  if (offsetSec !== undefined && offsetSec < 0) {
    throw new Error(`offsetSec must be >= 0 (got ${offsetSec})`);
  }

  return withTempVideoFile(input, async (filePath) => {
    const cropFilter = cropTopFraction !== undefined && cropTopFraction < 1
      ? `crop=iw:ih*${cropTopFraction}:0:0,`
      : '';
    const args = [
      '-hide_banner',
      '-loglevel', 'error',
      // Input seeking: must precede -i.
      ...(offsetSec !== undefined && offsetSec > 0 ? ['-ss', String(offsetSec)] : []),
      '-i', filePath,
      '-vf', `${cropFilter}fps=${1 / intervalSec},scale=720:-2`,
      '-frames:v', String(count),
      '-f', 'image2pipe',
      '-vcodec', 'mjpeg',
      'pipe:1',
    ];

    const proc = spawn(ffmpegPath as string, args, { stdio: ['ignore', 'pipe', 'pipe'] });

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    proc.stdout.on('data', (c: Buffer) => stdoutChunks.push(c));
    proc.stderr.on('data', (c: Buffer) => stderrChunks.push(c));

    const exitCode: number = await new Promise((resolve, reject) => {
      proc.on('error', reject);
      proc.on('close', resolve);
    });

    if (exitCode !== 0) {
      const stderr = Buffer.concat(stderrChunks).toString('utf8');
      throw new Error(`ffmpeg exited ${exitCode}: ${stderr}`);
    }

    const stream = Buffer.concat(stdoutChunks);
    const frames = splitMjpegStream(stream);

    if (frames.length === 0) {
      const stderr = Buffer.concat(stderrChunks).toString('utf8');
      throw new Error(`ffmpeg returned no frames. stderr: ${stderr}`);
    }
    return frames;
  });
}

function splitMjpegStream(stream: Buffer): Buffer[] {
  const frames: Buffer[] = [];
  let cursor = 0;
  while (cursor < stream.length) {
    const start = stream.indexOf(JPEG_SOI, cursor);
    if (start === -1) break;
    const end = stream.indexOf(JPEG_EOI, start + 2);
    if (end === -1) break;
    frames.push(stream.subarray(start, end + 2));
    cursor = end + 2;
  }
  return frames;
}
