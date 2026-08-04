import { describe, it, expect, beforeAll } from 'vitest';
import {
  signUnsubscribeToken,
  verifyUnsubscribeToken,
  buildUnsubscribeUrl,
} from '../unsubscribe';

// The security property being tested: an unsubscribe link authorises stopping
// mail to EXACTLY the address it was signed for. Anyone can read a token — it
// is sitting in an inbox — so the thing that must not be possible is editing
// one to target somebody else's address.

beforeAll(() => {
  process.env.EMAIL_UNSUBSCRIBE_SECRET = 'test-secret-not-used-anywhere-real';
});

describe('round trip', () => {
  it('recovers the address and category', () => {
    const t = signUnsubscribeToken('Player@Example.com', 'challenges');
    expect(verifyUnsubscribeToken(t)).toEqual({
      // Normalised at signing time so the verifier hands back exactly the form
      // the database is keyed on.
      email: 'player@example.com',
      category: 'challenges',
    });
  });

  it('treats an omitted category as "all"', () => {
    const claim = verifyUnsubscribeToken(signUnsubscribeToken('a@b.com'));
    expect(claim).toEqual({ email: 'a@b.com', category: null });
  });
});

describe('forgery', () => {
  it('rejects a token whose payload was swapped for another address', () => {
    const mine = signUnsubscribeToken('victim@example.com', 'matches');
    const sig = mine.slice(mine.lastIndexOf('.') + 1);

    // Re-encode a different address and reuse the original signature — the
    // attack the signature exists to stop.
    const forgedPayload = Buffer.from(
      JSON.stringify({ e: 'someone-else@example.com', c: 'matches' }),
      'utf8',
    ).toString('base64url');

    expect(verifyUnsubscribeToken(`${forgedPayload}.${sig}`)).toBeNull();
  });

  it('rejects a tampered signature', () => {
    const t = signUnsubscribeToken('a@b.com', 'matches');
    expect(verifyUnsubscribeToken(`${t}x`)).toBeNull();
  });

  it('rejects a token signed with a different secret', () => {
    const t = signUnsubscribeToken('a@b.com', 'matches');
    const original = process.env.EMAIL_UNSUBSCRIBE_SECRET;
    process.env.EMAIL_UNSUBSCRIBE_SECRET = 'a-different-secret';
    try {
      expect(verifyUnsubscribeToken(t)).toBeNull();
    } finally {
      process.env.EMAIL_UNSUBSCRIBE_SECRET = original;
    }
  });

  it('rejects junk without throwing', () => {
    for (const bad of ['', '.', 'nodot', 'a.b.c', 'x'.repeat(600)]) {
      expect(verifyUnsubscribeToken(bad)).toBeNull();
    }
  });

  it('fails closed when the secret is missing', () => {
    const t = signUnsubscribeToken('a@b.com');
    const original = process.env.EMAIL_UNSUBSCRIBE_SECRET;
    delete process.env.EMAIL_UNSUBSCRIBE_SECRET;
    try {
      // Never "no secret, so skip the check" — that would accept every token.
      expect(verifyUnsubscribeToken(t)).toBeNull();
    } finally {
      process.env.EMAIL_UNSUBSCRIBE_SECRET = original;
    }
  });
});

describe('buildUnsubscribeUrl', () => {
  it('returns null rather than a broken link when the base URL is unset', () => {
    expect(buildUnsubscribeUrl(undefined, 'a@b.com')).toBeNull();
    expect(buildUnsubscribeUrl('', 'a@b.com')).toBeNull();
  });

  it('does not double up slashes', () => {
    const url = buildUnsubscribeUrl('https://x.test/', 'a@b.com');
    expect(url?.startsWith('https://x.test/unsubscribe?token=')).toBe(true);
  });

  it('produces a link whose token survives URL encoding', () => {
    const url = buildUnsubscribeUrl('https://x.test', 'a@b.com', 'sessions')!;
    const token = new URL(url).searchParams.get('token')!;
    expect(verifyUnsubscribeToken(token)).toEqual({ email: 'a@b.com', category: 'sessions' });
  });
});
