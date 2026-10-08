// Signed passkey cookies (HMAC-SHA256, base64url(json).base64url(sig)).
// Ported from the admin app; kept byte-compatible so the two stay reviewable
// side by side. EDGE-SAFE: Web Crypto and btoa/atob only, no Node 'crypto'.
import { getCookieSecret } from './config';

type PasskeyCookiePayload = Record<string, unknown> & { exp: number };

function toBase64Url(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(value: string): Uint8Array | null {
  try {
    const bin = atob(value.replace(/-/g, '+').replace(/_/g, '/'));
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
  } catch {
    return null;
  }
}

async function hmac(data: string): Promise<Uint8Array> {
  const secret = getCookieSecret();
  // Callers gate on isPasskeyConfigured() first; this is the backstop that
  // stops an unset secret silently degrading to a constant key.
  if (!secret) throw new Error('PASSKEY_COOKIE_SECRET is not configured');
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data));
  return new Uint8Array(sig);
}

function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}

export async function signPayload(
  payload: Record<string, unknown>,
  ttlSeconds: number
): Promise<string> {
  const exp = Math.floor(Date.now() / 1000) + ttlSeconds;
  const body = toBase64Url(new TextEncoder().encode(JSON.stringify({ ...payload, exp })));
  const sig = toBase64Url(await hmac(body));
  return `${body}.${sig}`;
}

// Returns the payload for a valid, unexpired token; null for anything else
// (malformed, tampered signature, expired).
export async function verifyPayload(token: string): Promise<PasskeyCookiePayload | null> {
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [body, sig] = parts as [string, string];
  if (!body || !sig) return null;

  const givenSig = fromBase64Url(sig);
  if (!givenSig) return null;
  const expectedSig = await hmac(body);
  if (!timingSafeEqual(expectedSig, givenSig)) return null;

  const bodyBytes = fromBase64Url(body);
  if (!bodyBytes) return null;
  let payload: unknown;
  try {
    payload = JSON.parse(new TextDecoder().decode(bodyBytes));
  } catch {
    return null;
  }
  if (typeof payload !== 'object' || payload === null) return null;
  const exp = (payload as { exp?: unknown }).exp;
  if (typeof exp !== 'number' || exp < Math.floor(Date.now() / 1000)) return null;
  return payload as PasskeyCookiePayload;
}
