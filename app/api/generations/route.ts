import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db/client';
import { SESSION_COOKIE, verifySession } from '@/lib/auth/passcode';

export const runtime = 'nodejs';

export async function GET(req: NextRequest) {
  const session = await verifySession(req.cookies.get(SESSION_COOKIE)?.value ?? '');
  if (!session) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  // Join generations with their original attempts to get the storage_path.
  // generations.id is intentionally shared with generation_attempts.id.
  const r = await db()
    .from('generations')
    .select(
      'id, created_at, generated_titles, vision_description, generation_attempts!inner(storage_path)',
    )
    .order('created_at', { ascending: false })
    .limit(12);
  if (r.error) return NextResponse.json({ error: r.error.message }, { status: 500 });

  const items = (r.data ?? []).map((row) => {
    const titles = (row.generated_titles as Array<{ text: string }>) ?? [];
    const vision = (row.vision_description as { scene?: string } | null) ?? null;
    const attempt = row.generation_attempts as unknown as { storage_path: string } | null;
    return {
      id: row.id as string,
      createdAt: row.created_at as string,
      storagePath: attempt?.storage_path ?? '',
      topTitle: titles[0]?.text ?? '',
      sceneSummary: (vision?.scene ?? '').slice(0, 120),
    };
  });

  return NextResponse.json({ items });
}
