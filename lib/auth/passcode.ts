// Web Crypto only — runs in both Node (route handlers) and Edge (middleware).

const SESSION_TTL_SECONDS = 60 * 60 * 24 * 7; // 7 days
const enc = new TextEncoder();

export const SESSION_COOKIE = 'app_session';

type SessionPayload = { iat: number; exp: number; sid: string };

function b64url(bytes: ArrayBuffer | Uint8Array): string {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let bin = '';
  for (let i = 0; i < u8.length; i++) bin += String.fromCharCode(u8[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlDecode(s: string): Uint8Array {
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4));
  const b64 = (s + pad).replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

async function hmacKey(): Promise<CryptoKey> {
  const s = process.env.COOKIE_SECRET;
  if (!s || s.length < 32) {
    throw new Error('COOKIE_SECRET must be set and at least 32 chars');
  }
  return crypto.subtle.importKey(
    'raw',
    enc.encode(s),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  );
}

export async function signSession(): Promise<{ token: string; maxAge: number }> {
  const now = Math.floor(Date.now() / 1000);
  const sidBytes = new Uint8Array(16);
  crypto.getRandomValues(sidBytes);
  const sid = Array.from(sidBytes, (b) => b.toString(16).padStart(2, '0')).join('');

  const payload: SessionPayload = { iat: now, exp: now + SESSION_TTL_SECONDS, sid };
  const body = b64url(enc.encode(JSON.stringify(payload)));
  const key = await hmacKey();
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(body));
  return { token: `${body}.${b64url(sig)}`, maxAge: SESSION_TTL_SECONDS };
}

export async function verifySession(token: string | undefined): Promise<SessionPayload | null> {
  if (!token) return null;
  const dot = token.indexOf('.');
  if (dot < 1) return null;
  const body = token.slice(0, dot);
  const sig = token.slice(dot + 1);

  const key = await hmacKey();
  const expected = new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(body)));
  const got = b64urlDecode(sig);
  if (!constantTimeEqual(expected, got)) return null;

  const payload = parsePayload(body);
  if (!payload) return null;
  if (payload.exp < Math.floor(Date.now() / 1000)) return null;
  return payload;
}

function parsePayload(body: string): SessionPayload | null {
  const decoded = new TextDecoder().decode(b64urlDecode(body));
  const obj: unknown = JSON.parse(decoded);
  if (
    typeof obj !== 'object' || obj === null ||
    typeof (obj as SessionPayload).iat !== 'number' ||
    typeof (obj as SessionPayload).exp !== 'number' ||
    typeof (obj as SessionPayload).sid !== 'string'
  ) {
    return null;
  }
  return obj as SessionPayload;
}

export function checkPasscode(supplied: string): boolean {
  const expected = process.env.APP_PASSCODE;
  if (!expected) throw new Error('APP_PASSCODE must be set');
  return constantTimeEqual(enc.encode(supplied), enc.encode(expected));
}

export async function sessionHash(token: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', enc.encode(token));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}
