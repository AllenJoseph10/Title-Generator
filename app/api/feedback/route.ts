import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db/client';

export const runtime = 'nodejs';

type Body = { generation_id?: unknown; title_index?: unknown; vote?: unknown };

export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => null)) as Body | null;
  if (
    !body ||
    typeof body.generation_id !== 'string' ||
    typeof body.title_index !== 'number' ||
    !Number.isInteger(body.title_index) ||
    body.title_index < 0 ||
    body.title_index > 99
  ) {
    return NextResponse.json({ error: 'generation_id (uuid), title_index (int) required' }, { status: 400 });
  }
  if (body.vote !== -1 && body.vote !== 1) {
    return NextResponse.json({ error: 'vote must be -1 or 1' }, { status: 400 });
  }

  const up = await db()
    .from('title_feedback')
    .upsert(
      { generation_id: body.generation_id, title_index: body.title_index, vote: body.vote },
      { onConflict: 'generation_id,title_index' },
    );
  if (up.error) return NextResponse.json({ error: up.error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
