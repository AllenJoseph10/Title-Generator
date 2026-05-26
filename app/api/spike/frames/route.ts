import { NextRequest, NextResponse } from 'next/server';
import { extractFrames } from '@/lib/media/frames';

export const runtime = 'nodejs';
export const maxDuration = 60;

const MAX_BYTES = 50 * 1024 * 1024;
const ACCEPTED_MIME = new Set(['video/mp4', 'video/quicktime']);

export async function POST(req: NextRequest) {
  const contentType = req.headers.get('content-type') ?? '';
  if (!ACCEPTED_MIME.has(contentType)) {
    return NextResponse.json(
      { error: `unsupported content-type: ${contentType}` },
      { status: 400 },
    );
  }

  const ab = await req.arrayBuffer();
  if (ab.byteLength > MAX_BYTES) {
    return NextResponse.json(
      { error: `body too large: ${ab.byteLength} > ${MAX_BYTES}` },
      { status: 413 },
    );
  }
  const buf = Buffer.from(ab);

  const t0 = performance.now();
  const frames = await extractFrames(buf, 8);
  const durationMs = Math.round(performance.now() - t0);

  return NextResponse.json({
    frames: frames.length,
    durationMs,
    sizes: frames.map((f) => f.byteLength),
    inputBytes: buf.byteLength,
  });
}
