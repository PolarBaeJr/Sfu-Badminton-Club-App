import { describe, it, expect } from 'vitest';
import { rateLimit, getClientIp } from '../utils/rate-limit';
import { getMarginMultiplier, calculateEloUpdate } from '../elo/engine';
import { SWEEP_MARGIN_MULTIPLIER, isLegalGameScore, isLegalGameCount, derivedFormatWeight } from '../utils/constants';
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
  // The rule is "did the loser win a game?", not a literal 2-0 check — so it
  // keeps working unchanged if a best-of-5 format is ever added. With today's
  // formats the only reachable sweep is 2-0 in a best-of-3; a 3-0 cannot occur
  // (the match ends when someone clinches) and is now rejected outright by
  // isLegalGameCount.
  it('rewards a clean sweep on both sides', () => {
    expect(getMarginMultiplier(2, 0)).toBe(SWEEP_MARGIN_MULTIPLIER); // winner swept
    expect(getMarginMultiplier(0, 2)).toBe(SWEEP_MARGIN_MULTIPLIER); // loser got swept
  });

  it('the only sweep reachable today is 2-0 — 3-0 is not a legal result', () => {
    expect(isLegalGameCount(2, 0, 'bo3_21')).toBe(true);
    expect(isLegalGameCount(3, 0, 'bo3_21')).toBe(false);
  });

  it('does not scale a match that went the distance', () => {
    expect(getMarginMultiplier(2, 1)).toBe(1.0);
    expect(getMarginMultiplier(1, 2)).toBe(1.0);
  });

  it('never scales single-game formats or walkovers', () => {
    expect(getMarginMultiplier(1, 0)).toBe(1.0);  // a 1-game format has no margin
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

describe('badminton score legality', () => {
  it('accepts a clean finish and a whitewash', () => {
    expect(isLegalGameScore(21, 19, 'bo3_21')).toBe(true);
    expect(isLegalGameScore(21, 0, 'bo3_21')).toBe(true);
  });

  it('rejects 21-20 — rally scoring requires winning by two', () => {
    expect(isLegalGameScore(21, 20, 'bo3_21')).toBe(false);
  });

  it('accepts deuce finishes and the 30-29 cap', () => {
    expect(isLegalGameScore(22, 20, 'bo3_21')).toBe(true);
    expect(isLegalGameScore(29, 27, 'bo3_21')).toBe(true);
    expect(isLegalGameScore(30, 28, 'bo3_21')).toBe(true);
    expect(isLegalGameScore(30, 29, 'bo3_21')).toBe(true); // the cap decides it
  });

  it('rejects scores past the cap, short of the target, and ties', () => {
    expect(isLegalGameScore(31, 29, 'bo3_21')).toBe(false);
    expect(isLegalGameScore(20, 18, 'bo3_21')).toBe(false);
    expect(isLegalGameScore(21, 21, 'bo3_21')).toBe(false);
  });

  it('scales the target and cap per format', () => {
    expect(isLegalGameScore(15, 13, 'single_15')).toBe(true);
    expect(isLegalGameScore(24, 23, 'single_15')).toBe(true);  // 15-point cap is 24
    expect(isLegalGameScore(11, 10, 'single_11')).toBe(false); // must win by two
    expect(isLegalGameScore(20, 19, 'single_11')).toBe(true);  // 11-point cap is 20
  });

  it('a best-of-3 is 2-0 or 2-1 — never 3-0', () => {
    expect(isLegalGameCount(2, 0, 'bo3_21')).toBe(true);
    expect(isLegalGameCount(2, 1, 'bo3_21')).toBe(true);
    expect(isLegalGameCount(3, 0, 'bo3_21')).toBe(false); // match ended at 2-0
    expect(isLegalGameCount(1, 0, 'bo3_21')).toBe(false); // nobody clinched
  });

  it('a single-game format is exactly one game', () => {
    expect(isLegalGameCount(1, 0, 'single_21')).toBe(true);
    expect(isLegalGameCount(2, 0, 'single_21')).toBe(false);
  });
});

describe('score rules apply to tournament formats too', () => {
  it('uses the same targets and caps as the challenge equivalents', () => {
    expect(isLegalGameScore(21, 20, 'best_of_3_to_21')).toBe(false); // impossible
    expect(isLegalGameScore(30, 29, 'best_of_3_to_21')).toBe(true);  // the cap
    expect(isLegalGameScore(22, 20, 'one_game_21')).toBe(true);
    expect(isLegalGameScore(11, 10, 'one_game_11')).toBe(false);     // win by two
    expect(isLegalGameScore(20, 19, 'one_game_11')).toBe(true);      // 11-pt cap
  });

  it('applies the clinch rule to tournament best-of-3', () => {
    expect(isLegalGameCount(2, 1, 'best_of_3_to_21')).toBe(true);
    expect(isLegalGameCount(3, 0, 'best_of_3_to_21')).toBe(false);
    expect(isLegalGameCount(1, 0, 'one_game_21')).toBe(true);
  });
});

describe('custom formats (best of X to Y)', () => {
  it('derives an Elo weight that reproduces the presets', () => {
    expect(derivedFormatWeight(3, 21)).toBeCloseTo(1.25, 2); // bo3_21
    expect(derivedFormatWeight(1, 21)).toBeCloseTo(1.0, 2);  // single_21
  });

  it('clamps so a trivial or oversized format cannot be farmed', () => {
    expect(derivedFormatWeight(1, 5)).toBeGreaterThanOrEqual(0.25);
    expect(derivedFormatWeight(7, 30)).toBeLessThanOrEqual(1.5);
  });

  it('validates scores against the custom target, not the preset', () => {
    // best of 5 to 15: cap is 24, so 24-23 decides it and 15-14 does not
    expect(isLegalGameScore(24, 23, 'bo3_21', 5, 15)).toBe(true);
    expect(isLegalGameScore(15, 14, 'bo3_21', 5, 15)).toBe(false);
    expect(isLegalGameScore(15, 13, 'bo3_21', 5, 15)).toBe(true);
  });

  it('applies the clinch rule to the custom best-of', () => {
    expect(isLegalGameCount(3, 1, 'bo3_21', 5)).toBe(true);  // best of 5
    expect(isLegalGameCount(2, 1, 'bo3_21', 5)).toBe(false); // nobody clinched
    expect(isLegalGameCount(4, 1, 'bo3_21', 5)).toBe(false); // played past it
  });
});
