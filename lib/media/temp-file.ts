import { writeFile, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

// MP4s usually keep their `moov` metadata atom at the END of the file, which
// means ffmpeg has to seek backwards to demux them. Pipes are non-seekable,
// so the buffer must hit disk before ffmpeg can read it.
export async function withTempVideoFile<T>(
  bytes: Buffer,
  fn: (path: string) => Promise<T>,
): Promise<T> {
  const path = join(tmpdir(), `tg-${randomUUID()}.mp4`);
  await writeFile(path, bytes);
  try {
    return await fn(path);
  } finally {
    await unlink(path).catch(() => {});
  }
}
