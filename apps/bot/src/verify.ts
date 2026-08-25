import { createPublicKey, verify } from 'node:crypto';

// Ed25519 verification of Discord's request signatures.
//
// Discord signs every interaction POST and REQUIRES that an invalid signature be
// answered with 401. It probes this during endpoint setup: an endpoint that
// accepts a deliberately bad signature is rejected outright. So this is not
// defence-in-depth, it is the thing that makes the endpoint valid at all.
//
// Done with node:crypto rather than a library because Node has Ed25519 natively
// and the only awkward part is small: crypto wants a KeyObject, while Discord
// publishes a bare 32-byte hex public key. The fixed 12-byte prefix below is the
// DER SPKI header for Ed25519 (RFC 8410) — algorithm id 1.3.101.112 — and
// wrapping the raw key in it produces the SPKI DER that createPublicKey accepts.
// It is constant for every Ed25519 key; nothing here is Discord-specific.
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

function toKeyObject(publicKeyHex: string) {
  const raw = Buffer.from(publicKeyHex, 'hex');
  if (raw.length !== 32) {
    throw new Error(`DISCORD_PUBLIC_KEY must be 32 bytes of hex, got ${raw.length}`);
  }
  return createPublicKey({
    key: Buffer.concat([ED25519_SPKI_PREFIX, raw]),
    format: 'der',
    type: 'spki',
  });
}

// Cached because createPublicKey parses DER on every call and interactions are
// the hot path.
//
// KEYED BY THE HEX, not a bare singleton. A single cached KeyObject would ignore
// the argument after the first call, so a rotated DISCORD_PUBLIC_KEY would keep
// verifying against the old key until the process restarted — passing silently,
// which is the worst way for a signature check to be wrong. The map is bounded
// in practice by the number of distinct keys the process is configured with,
// which is one.
const keyCache = new Map<string, ReturnType<typeof createPublicKey>>();

export function verifyDiscordRequest(
  publicKeyHex: string,
  signatureHex: string | undefined,
  timestamp: string | undefined,
  rawBody: string
): boolean {
  if (!signatureHex || !timestamp) return false;

  try {
    let key = keyCache.get(publicKeyHex);
    if (!key) {
      key = toKeyObject(publicKeyHex);
      keyCache.set(publicKeyHex, key);
    }
    const signature = Buffer.from(signatureHex, 'hex');
    // A malformed hex signature decodes to the wrong length rather than
    // throwing. Reject it here so verify() is never handed junk.
    if (signature.length !== 64) return false;

    // The signed payload is timestamp + raw body, and it MUST be the raw body:
    // re-serialising parsed JSON reorders keys and changes whitespace, which
    // silently breaks every signature. index.ts keeps the raw string for this.
    return verify(null, Buffer.from(timestamp + rawBody), key, signature);
  } catch {
    return false;
  }
}
