import { describe, it, expect } from 'vitest';
import { rateLimit, getClientIp } from '../utils/rate-limit';
import { getMarginMultiplier, calculateEloUpdate } from '../elo/engine';
import { ExpectedError, isExpectedError } from '../utils/expected-error';
import { parseOrThrow } from '../validators/parse';
import { z } from 'zod';
import { SWEEP_MARGIN_MULTIPLIER } from '../utils/constants';
import { escapeHtml, challengeReceivedEmail, disputeOpenedEmail } from '../email/templates';

function req(headers: Record<string, string>): Request {
  return new Request('https://example.test/', { headers });
}

describe('getClientIp', () => {
  it('prefers cf-connecting-ip (authoritative behind Cloudflare)', () => {
    expect(
      getClientIp(req({ 'cf-connecting-ip': '9.9.9.9', 'x-forwarded-for': '1.1.1.1, 2.2.2.2' })),
    ).toBe('9.9.9.9');
  });

  it('uses the RIGHTMOST forwarded hop, not the client-supplied leftmost', () => {
    // A client prepending "1.1.1.1" must not control the bucket key — the
    // rightmost entry is the one our own proxy appended.
    expect(getClientIp(req({ 'x-forwarded-for': '1.1.1.1, 203.0.113.7' }))).toBe('203.0.113.7');
  });

  it('cannot be rotated by a spoofed leftmost header (same bucket every time)', () => {
    const a = getClientIp(req({ 'x-forwarded-for': 'a.a.a.a, 203.0.113.7' }));
    const b = getClientIp(req({ 'x-forwarded-for': 'b.b.b.b, 203.0.113.7' }));
    expect(a).toBe(b);
  });

  it('falls back to x-real-ip, then unknown', () => {
    expect(getClientIp(req({ 'x-real-ip': '198.51.100.4' }))).toBe('198.51.100.4');
    expect(getClientIp(req({}))).toBe('unknown');
  });
});

describe('rateLimit', () => {
  it('allows up to the limit then blocks within the window', () => {
    const key = `test-${Math.random()}`;
    expect(rateLimit(key, 2, 60_000).success).toBe(true);
    expect(rateLimit(key, 2, 60_000).success).toBe(true);
    const third = rateLimit(key, 2, 60_000);
    expect(third.success).toBe(false);
    expect(third.remaining).toBe(0);
  });

  it('keeps separate buckets per key', () => {
    const a = `test-a-${Math.random()}`;
    const b = `test-b-${Math.random()}`;
    rateLimit(a, 1, 60_000);
    expect(rateLimit(a, 1, 60_000).success).toBe(false);
    expect(rateLimit(b, 1, 60_000).success).toBe(true);
  });
});

describe('escapeHtml', () => {
  it('neutralises tags and quotes', () => {
    expect(escapeHtml('<script>alert(1)</script>')).toBe(
      '&lt;script&gt;alert(1)&lt;/script&gt;',
    );
    expect(escapeHtml(`"'&`)).toBe('&quot;&#39;&amp;');
  });

  it('handles null/undefined', () => {
    expect(escapeHtml(null)).toBe('');
    expect(escapeHtml(undefined)).toBe('');
  });
});

describe('email templates escape user-controlled values', () => {
  it('does not emit a raw injected anchor from a player name', () => {
    const evil = '<a href="https://phish.test">Click</a>';
    const { html } = challengeReceivedEmail(evil, 'bo3_21', 'singles', 'https://app.test/c/1');
    expect(html).not.toContain('<a href="https://phish.test"');
    expect(html).toContain('&lt;a href=');
  });

  it('escapes a dispute reason', () => {
    const { html } = disputeOpenedEmail('21-19', '<img src=x onerror=alert(1)>', 'https://app.test/d/1');
    expect(html).not.toContain('<img src=x');
    expect(html).toContain('&lt;img src=x');
  });

  it('strips newlines from subjects (header injection)', () => {
    const { subject } = challengeReceivedEmail('Bad\r\nBcc: victim@test', 'bo3_21', 'singles', 'u');
    expect(subject).not.toMatch(/[\r\n]/);
  });
});

describe('getMarginMultiplier (Elo margin-of-victory scaling)', () => {
  it('rewards a clean sweep on both sides', () => {
    expect(getMarginMultiplier(2, 0)).toBe(SWEEP_MARGIN_MULTIPLIER); // winner swept
    expect(getMarginMultiplier(0, 2)).toBe(SWEEP_MARGIN_MULTIPLIER); // loser got swept
  });

  it('does not scale a match that went the distance', () => {
    expect(getMarginMultiplier(2, 1)).toBe(1.0);
    expect(getMarginMultiplier(1, 2)).toBe(1.0);
  });

  it('never scales single-game formats or walkovers', () => {
    expect(getMarginMultiplier(1, 0)).toBe(1.0);
    expect(getMarginMultiplier(0, 1)).toBe(1.0);
    expect(getMarginMultiplier(0, 0)).toBe(1.0);
  });

  it('applies the multiplier to the delta, symmetrically', () => {
    const base = { playerRating: 500, opponentRating: 500, kFactor: 48, formatWeight: 1.25, eventMultiplier: 1.0 };
    const flat = calculateEloUpdate({ ...base, won: true });
    const swept = calculateEloUpdate({ ...base, won: true, marginMultiplier: getMarginMultiplier(2, 0) });
    expect(swept.delta).toBeGreaterThan(flat.delta);
    // loser of a sweep drops by the same magnitude the winner gains
    const loser = calculateEloUpdate({ ...base, won: false, marginMultiplier: getMarginMultiplier(0, 2) });
    expect(Math.abs(loser.delta)).toBe(swept.delta);
  });
});

describe('ExpectedError (Sentry noise suppression)', () => {
  it('recognises its own instances', () => {
    expect(isExpectedError(new ExpectedError('nope'))).toBe(true);
  });

  it('does NOT treat ordinary errors as expected — unmarked failures still report', () => {
    expect(isExpectedError(new Error('boom'))).toBe(false);
    expect(isExpectedError(null)).toBe(false);
    expect(isExpectedError('boom')).toBe(false);
  });

  it('marks validation failures, so bad user input never pages anyone', () => {
    const schema = z.object({ description: z.string().min(10) });
    try {
      parseOrThrow(schema, { description: 'too short' });
      throw new Error('should have thrown');
    } catch (err) {
      expect(isExpectedError(err)).toBe(true);
      // the user-facing message is unchanged
      expect((err as Error).message).toContain('description');
    }
  });
});
