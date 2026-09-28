// THE MIDDLEWARE'S getUser() ANSWER, HANDED TO THE RENDER THAT FOLLOWS IT.
//
// Every signed-in page used to ask GoTrue "who is this" twice: once in the
// middleware, and again in loadViewer() for the same request, because the two
// run in separate runtimes with no memory in common. The second answer could
// never differ from the first (same cookie, milliseconds apart), so the
// middleware now forwards the verified user id on an internal request header
// and loadViewer() takes it from there instead of paying the round trip.
//
// SIGNED, NOT TRUSTED BY NAME. A request header is something a caller can send,
// and the middleware's matcher deliberately skips some paths (see its config),
// so "the middleware always overwrites it" would be one mis-edited regex away
// from letting anybody name any user id. The value carries an HMAC over the id
// and a timestamp, keyed by a server-only secret: a forged or replayed header
// fails verification and loadViewer() falls back to asking GoTrue, exactly as
// it did before this existed. Web Crypto, so the same code runs in the edge
// middleware and in Node.

export const VIEWER_HEADER = 'x-sfu-viewer';

// Covers one request's middleware-to-render gap with room to spare. Anything
// older is refused rather than trusted, so a captured value is useless soon
// after it was minted.
export const VIEWER_MAX_AGE_MS = 30_000;
// Clock skew tolerated in the other direction, for a value minted "in the
// future" by a replica whose clock runs slightly ahead.
const FUTURE_SKEW_MS = 5_000;

const encoder = new TextEncoder();
const LABEL = 'sfu-viewer-v1';

let cachedKey: { secret: string; key: Promise<CryptoKey> } | null = null;

function viewerKey(): Promise<CryptoKey> | null {
  const secret = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!secret) return null;
  if (cachedKey?.secret !== secret) {
    cachedKey = {
      secret,
      key: crypto.subtle.importKey(
        'raw',
        encoder.encode(secret),
        { name: 'HMAC', hash: 'SHA-256' },
        false,
        ['sign', 'verify'],
      ),
    };
  }
  return cachedKey.key;
}

function toBase64Url(bytes: ArrayBuffer): string {
  let s = '';
  for (const b of new Uint8Array(bytes)) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(s: string): Uint8Array<ArrayBuffer> | null {
  try {
    const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/'));
    const out = new Uint8Array(new ArrayBuffer(bin.length));
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

/** `<userId>.<issuedAtMs>.<signature>`, or null when no key is configured, in
 *  which case the header is simply not sent and render asks GoTrue itself. */
export async function signViewer(userId: string, now = Date.now()): Promise<string | null> {
  const key = viewerKey();
  if (!key) return null;
  const payload = `${userId}.${now}`;
  const sig = await crypto.subtle.sign('HMAC', await key, encoder.encode(`${LABEL}.${payload}`));
  return `${payload}.${toBase64Url(sig)}`;
}

/** The user id the value was minted for, or null for anything missing,
 *  malformed, expired, from the future, or not signed with this server's key. */
export async function readViewer(
  value: string | null | undefined,
  now = Date.now(),
): Promise<string | null> {
  if (!value) return null;
  const key = viewerKey();
  if (!key) return null;
  const parts = value.split('.');
  if (parts.length !== 3) return null;
  const [userId, issued, sigText] = parts;
  if (!userId || !issued || !sigText || !/^\d+$/.test(issued)) return null;
  const age = now - Number(issued);
  if (age > VIEWER_MAX_AGE_MS || age < -FUTURE_SKEW_MS) return null;
  const sig = fromBase64Url(sigText);
  if (!sig) return null;
  // subtle.verify, not a string compare of a re-signed value: it compares in
  // constant time.
  const ok = await crypto.subtle.verify(
    'HMAC',
    await key,
    sig,
    encoder.encode(`${LABEL}.${userId}.${issued}`),
  );
  return ok ? userId : null;
}
