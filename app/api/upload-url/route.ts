import { NextRequest, NextResponse } from 'next/server';
import { createSignedUpload } from '@/lib/storage/upload';
import { MAX_BYTES, isAcceptedMime, rejectUpload } from '@/lib/storage/constants';

export const runtime = 'nodejs';

type Body = { filename?: unknown; mime?: unknown; size?: unknown };

export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => null)) as Body | null;
  if (!body || typeof body.filename !== 'string' || typeof body.mime !== 'string' || typeof body.size !== 'number') {
    return NextResponse.json({ error: 'filename, mime, size required' }, { status: 400 });
  }
  // page.tsx pipes `error` straight into a toast, so these strings are read by
  // a user, not just a log. `size out of range: 83309337` named neither the
  // limit nor the units and suggested nothing — rejectUpload is shared with
  // the dropzone so both layers say the same actionable thing.
  // The mime guard stays a distinct statement because it also narrows the type
  // that createSignedUpload requires; folding it into one call loses that.
  if (!isAcceptedMime(body.mime)) {
    return NextResponse.json({ error: rejectUpload(body.size, body.mime) }, { status: 415 });
  }
  const problem = rejectUpload(body.size, body.mime);
  if (problem) {
    return NextResponse.json({ error: problem }, { status: body.size > MAX_BYTES ? 413 : 400 });
  }

  const signed = await createSignedUpload(body.mime);
  return NextResponse.json(signed);
}
