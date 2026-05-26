import { NextRequest, NextResponse } from 'next/server';
import { createSignedUpload } from '@/lib/storage/upload';
import { MAX_BYTES, isAcceptedMime } from '@/lib/storage/constants';

export const runtime = 'nodejs';

type Body = { filename?: unknown; mime?: unknown; size?: unknown };

export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => null)) as Body | null;
  if (!body || typeof body.filename !== 'string' || typeof body.mime !== 'string' || typeof body.size !== 'number') {
    return NextResponse.json({ error: 'filename, mime, size required' }, { status: 400 });
  }
  if (!isAcceptedMime(body.mime)) {
    return NextResponse.json({ error: `unsupported mime: ${body.mime}` }, { status: 415 });
  }
  if (body.size <= 0 || body.size > MAX_BYTES) {
    return NextResponse.json({ error: `size out of range: ${body.size}` }, { status: 413 });
  }

  const signed = await createSignedUpload(body.mime);
  return NextResponse.json(signed);
}
