import { spawn } from 'node:child_process';
import ffmpegPath from 'ffmpeg-static';

const JPEG_SOI = Buffer.from([0xff, 0xd8]);
const JPEG_EOI = Buffer.from([0xff, 0xd9]);

export async function extractFrames(input: Buffer, count: number): Promise<Buffer[]> {
  if (!ffmpegPath) {
    throw new Error('ffmpeg-static did not resolve a binary path on this platform');
  }
  if (count < 1) throw new Error(`count must be >= 1 (got ${count})`);

  const args = [
    '-hide_banner',
    '-loglevel', 'error',
    '-i', 'pipe:0',
    '-vf', `fps=1/2,scale=720:-2`,
    '-frames:v', String(count),
    '-f', 'image2pipe',
    '-vcodec', 'mjpeg',
    'pipe:1',
  ];

  const proc = spawn(ffmpegPath, args, { stdio: ['pipe', 'pipe', 'pipe'] });

  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];
  proc.stdout.on('data', (c: Buffer) => stdoutChunks.push(c));
  proc.stderr.on('data', (c: Buffer) => stderrChunks.push(c));

  proc.stdin.end(input);

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
