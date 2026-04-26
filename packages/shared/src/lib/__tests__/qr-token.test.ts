import { describe, it, expect, beforeAll } from 'vitest';
import { generateQrToken, verifyQrToken } from '../qr-token';

const CID = '0d8d6fa0-4e8b-4b0c-9c9e-000000000001';

beforeAll(() => {
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-secret-for-qr-tokens';
});

describe('qr-token', () => {
  it('generates and verifies a valid token round-trip', () => {
    const token = generateQrToken(CID, 7);
    const result = verifyQrToken(token, CID);
    expect(result.valid).toBe(true);
  });

  it('rejects tokens signed with a different secret', () => {
    const token = generateQrToken(CID, 7);
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'different-secret';
    const result = verifyQrToken(token, CID);
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.reason).toBe('tampered');
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-secret-for-qr-tokens';
  });

  it('rejects tokens whose challengeId does not match', () => {
    const token = generateQrToken(CID, 7);
    const result = verifyQrToken(token, 'different-challenge-id');
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.reason).toBe('mismatch');
  });

  it('rejects tokens that have expired', () => {
    // Generate with an already-past expiry by mocking Date.now briefly.
    const realNow = Date.now;
    Date.now = () => (realNow() - 1000 * 3600 * 24 * 30);
    const token = generateQrToken(CID, 1); // 1 day from 30 days ago = 29 days ago
    Date.now = realNow;
    const result = verifyQrToken(token, CID);
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.reason).toBe('expired');
  });

  it('rejects malformed tokens', () => {
    expect(verifyQrToken('not-a-token', CID).valid).toBe(false);
    expect(verifyQrToken('', CID).valid).toBe(false);
    expect(verifyQrToken('only-one-part', CID).valid).toBe(false);
  });

  it('rejects tokens with a tampered payload', () => {
    const token = generateQrToken(CID, 7);
    const [, sig] = token.split('.');
    // Replace payload with a forged one; signature will no longer match.
    const forgedPayload = Buffer.from(JSON.stringify({ cid: CID, exp: 9999999999 })).toString('base64')
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    const tampered = `${forgedPayload}.${sig}`;
    const result = verifyQrToken(tampered, CID);
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.reason).toBe('tampered');
  });

  it('rejects tokens with a tampered signature', () => {
    const token = generateQrToken(CID, 7);
    const [payload] = token.split('.');
    const tampered = `${payload}.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA`;
    const result = verifyQrToken(tampered, CID);
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.reason).toBe('tampered');
  });

  it('rejects zero or negative expiresInDays', () => {
    expect(() => generateQrToken(CID, 0)).toThrow();
    expect(() => generateQrToken(CID, -1)).toThrow();
  });
});
