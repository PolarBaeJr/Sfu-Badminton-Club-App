import crypto from 'node:crypto';

/**
 * HMAC-SHA256 signed tokens for QR-code result submission.
 *
 * Format: base64url(payload).base64url(signature)
 * Payload is JSON: { cid: challengeId, exp: unixTimestampSec }
 *
 * Uses SUPABASE_SERVICE_ROLE_KEY as the HMAC secret because it already
 * exists server-side and rotating it would invalidate outstanding QR codes
 * (acceptable — if the key rotates, admins regenerate).
 */

type QrPayload = { cid: string; exp: number };

export type QrTokenVerification =
  | { valid: true; payload: QrPayload }
  | { valid: false; reason: 'expired' | 'tampered' | 'mismatch' | 'malformed' };

function getSecret(): string {
  const secret = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!secret) {
    throw new Error('SUPABASE_SERVICE_ROLE_KEY is required for QR token signing');
  }
  return secret;
}

function base64urlEncode(buf: Buffer | string): string {
  const b = typeof buf === 'string' ? Buffer.from(buf, 'utf8') : buf;
  return b.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64urlDecode(input: string): Buffer {
  const pad = input.length % 4 === 0 ? '' : '='.repeat(4 - (input.length % 4));
  const b64 = input.replace(/-/g, '+').replace(/_/g, '/') + pad;
  return Buffer.from(b64, 'base64');
}

function sign(payloadB64: string, secret: string): string {
  return base64urlEncode(
    crypto.createHmac('sha256', secret).update(payloadB64).digest()
  );
}

export function generateQrToken(challengeId: string, expiresInDays: number): string {
  if (!challengeId) throw new Error('challengeId is required');
  if (!Number.isFinite(expiresInDays) || expiresInDays <= 0) {
    throw new Error('expiresInDays must be > 0');
  }

  const exp = Math.floor(Date.now() / 1000) + Math.floor(expiresInDays * 86400);
  const payload: QrPayload = { cid: challengeId, exp };
  const payloadB64 = base64urlEncode(JSON.stringify(payload));
  const sigB64 = sign(payloadB64, getSecret());
  return `${payloadB64}.${sigB64}`;
}

export function verifyQrToken(token: string, challengeId: string): QrTokenVerification {
  if (typeof token !== 'string' || !token.includes('.')) {
    return { valid: false, reason: 'malformed' };
  }
  const [payloadB64, sigB64] = token.split('.', 2);
  if (!payloadB64 || !sigB64) {
    return { valid: false, reason: 'malformed' };
  }

  const expectedSig = sign(payloadB64, getSecret());
  // Constant-time compare to defeat timing oracles.
  const a = Buffer.from(sigB64);
  const b = Buffer.from(expectedSig);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return { valid: false, reason: 'tampered' };
  }

  let payload: QrPayload;
  try {
    payload = JSON.parse(base64urlDecode(payloadB64).toString('utf8')) as QrPayload;
  } catch {
    return { valid: false, reason: 'malformed' };
  }

  if (typeof payload?.cid !== 'string' || typeof payload?.exp !== 'number') {
    return { valid: false, reason: 'malformed' };
  }

  if (payload.cid !== challengeId) {
    return { valid: false, reason: 'mismatch' };
  }

  if (payload.exp < Math.floor(Date.now() / 1000)) {
    return { valid: false, reason: 'expired' };
  }

  return { valid: true, payload };
}
