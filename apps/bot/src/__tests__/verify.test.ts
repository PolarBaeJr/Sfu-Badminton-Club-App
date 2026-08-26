import { describe, expect, it } from 'vitest';
import { generateKeyPairSync, sign } from 'node:crypto';
import { verifyDiscordRequest } from '../verify.js';

// Real Ed25519 keys, not fixtures: this asserts the DER/SPKI wrapping in
// verify.ts actually round-trips, which is the one thing in that file that could
// be subtly wrong and still typecheck.
function keypair() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const raw = publicKey.export({ format: 'der', type: 'spki' }).subarray(12);
  return { privateKey, publicKeyHex: raw.toString('hex') };
}

describe('verifyDiscordRequest', () => {
  const { privateKey, publicKeyHex } = keypair();
  const timestamp = '1700000000';
  const body = '{"type":1}';
  const signature = sign(null, Buffer.from(timestamp + body), privateKey).toString('hex');

  it('accepts a correctly signed request', () => {
    expect(verifyDiscordRequest(publicKeyHex, signature, timestamp, body)).toBe(true);
  });

  // Discord probes with a deliberately bad signature during endpoint setup and
  // rejects any endpoint that accepts it, so this case is load-bearing.
  it('rejects a tampered body', () => {
    expect(verifyDiscordRequest(publicKeyHex, signature, timestamp, '{"type":2}')).toBe(false);
  });

  it('rejects a replayed signature under a different timestamp', () => {
    expect(verifyDiscordRequest(publicKeyHex, signature, '1700000001', body)).toBe(false);
  });

  it('rejects a signature from a different key', () => {
    const other = keypair();
    expect(verifyDiscordRequest(other.publicKeyHex, signature, timestamp, body)).toBe(false);
  });

  it('rejects missing signature or timestamp', () => {
    expect(verifyDiscordRequest(publicKeyHex, undefined, timestamp, body)).toBe(false);
    expect(verifyDiscordRequest(publicKeyHex, signature, undefined, body)).toBe(false);
  });

  // Malformed hex decodes short rather than throwing, so this would reach
  // crypto.verify as junk without the explicit length check.
  it('rejects a malformed signature without throwing', () => {
    expect(verifyDiscordRequest(publicKeyHex, 'not-hex', timestamp, body)).toBe(false);
    expect(verifyDiscordRequest(publicKeyHex, 'abcd', timestamp, body)).toBe(false);
  });
});
