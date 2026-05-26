import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db/client';
import { BUCKET } from '@/lib/storage/constants';
import { SESSION_COOKIE, verifySession } from '@/lib/auth/passcode';

export const runtime = 'nodejs';

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await verifySession(req.cookies.get(SESSION_COOKIE)?.value ?? '');
  if (!session) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) {
    return NextResponse.json({ error: 'bad id' }, { status: 400 });
  }

  const r = await db()
    .from('generations')
    .select(
      'id, created_at, generated_titles, vision_description, cost_usd, duration_ms, generation_attempts!inner(storage_path)',
    )
    .eq('id', id)
    .maybeSingle();
  if (r.error) return NextResponse.json({ error: r.error.message }, { status: 500 });
  if (!r.data) return NextResponse.json({ error: 'not found' }, { status: 404 });

  const attempt = r.data.generation_attempts as unknown as { storage_path: string } | null;
  const storagePath = attempt?.storage_path ?? '';

  // Mint a signed download URL valid for 1 hour.
  let signedUrl: string | null = null;
  if (storagePath) {
    const signed = await db().storage.from(BUCKET).createSignedUrl(storagePath, 3600);
    if (!signed.error) signedUrl = signed.data.signedUrl;
  }

  return NextResponse.json({
    id: r.data.id,
    titles: r.data.generated_titles,
    visionDescription: r.data.vision_description,
    storagePath,
    signedUrl,
    costUsd: r.data.cost_usd,
    durationMs: r.data.duration_ms,
    createdAt: r.data.created_at,
  });
}
