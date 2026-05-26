import { NextRequest, NextResponse } from 'next/server';
import { checkPasscode, signSession, SESSION_COOKIE } from '@/lib/auth/passcode';

export const runtime = 'nodejs';

export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => null)) as { passcode?: unknown } | null;
  const supplied = typeof body?.passcode === 'string' ? body.passcode : '';
  if (!checkPasscode(supplied)) {
    return NextResponse.json({ error: 'invalid passcode' }, { status: 401 });
  }
  const { token, maxAge } = await signSession();
  const res = NextResponse.json({ ok: true });
  res.cookies.set(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'strict',
    path: '/',
    maxAge,
  });
  return res;
}
