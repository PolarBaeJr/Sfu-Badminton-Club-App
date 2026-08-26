import { describe, it, expect } from 'vitest';
import { rateLimit } from '../utils/rate-limit';
import { getMarginMultiplier, calculateEloUpdate } from '../elo/engine';
import { SWEEP_MARGIN_MULTIPLIER, isLegalGameScore, isLegalTimeExceededScore, isLegalGameCount, derivedFormatWeight } from '../utils/constants';
import { ExpectedError, isExpectedError, dbError, isExpectedDbGuard } from '../utils/expected-error';
import { parseOrThrow } from '../validators/parse';
import { z } from 'zod';
import { escapeHtml, challengeReceivedEmail, disputeOpenedEmail } from '../email/templates';

function req(headers: Record<string, string>): Request {
  return new Request('https://example.test/', { headers });
}


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

// The club plays inside a booked gym slot, so the exec can call time mid-game
// and the score at that moment stands (00047). These cover the relaxation and,
// more importantly, its edges — the flag must not become a way to record a
// scoreline that could not have happened at all.
describe('time-exceeded scores', () => {
  it('accepts a game the clock cut short, which the normal rules reject', () => {
    expect(isLegalGameScore(15, 2, 'best_of_3_to_21', null, null, true)).toBe(true);
    expect(isLegalGameScore(15, 2, 'best_of_3_to_21')).toBe(false);
  });

  it('still needs a winner — a tie is not a result either way', () => {
    expect(isLegalGameScore(15, 15, 'best_of_3_to_21', null, null, true)).toBe(false);
    expect(isLegalGameScore(15, 15, 'best_of_3_to_21')).toBe(false);
  });

  it('still refuses anything past the cap, flag or no flag', () => {
    // Past 30 the game would have ended on its own, so the clock cannot be what
    // stopped it.
    expect(isLegalGameScore(31, 2, 'best_of_3_to_21', null, null, true)).toBe(false);
    expect(isLegalGameScore(31, 2, 'best_of_3_to_21')).toBe(false);
    // 29-28 is a game still on court in deuce: nobody has two clear and nobody
    // has the cap, so the clock could genuinely have stopped it.
    expect(isLegalGameScore(29, 28, 'best_of_3_to_21', null, null, true)).toBe(true);
    // 30-29 is NOT. Taking the cap WINS the game, so that game ended on its own
    // and the clock cannot be what stopped it. This assertion used to expect
    // true, which is what let 21-2 through in a game to 15.
    expect(isLegalGameScore(30, 29, 'best_of_3_to_21', null, null, true)).toBe(false);
  });

  it('refuses a game that had already been won, whatever the clock says', () => {
    // Reported from staging: a quarter-final played to 15 accepted 21-2 with
    // the time-exceeded flag on, and named a winner. That game ended at 15-2 —
    // it could not still have been on court when time was called. The flag
    // excuses a game that never FINISHED; it cannot excuse one already won.
    expect(isLegalGameScore(21, 2, 'one_game_15', null, null, true)).toBe(false);
    expect(isLegalGameScore(15, 2, 'one_game_15', null, null, true)).toBe(false);
    // Genuinely cut short, and still legal: nobody had reached 15 with two clear.
    expect(isLegalGameScore(14, 2, 'one_game_15', null, null, true)).toBe(true);
    expect(isLegalGameScore(9, 4, 'one_game_11', null, null, true)).toBe(true);
    // The same shape one round earlier, played to 11.
    expect(isLegalGameScore(15, 2, 'one_game_11', null, null, true)).toBe(false);
  });

  it('rejects negatives and non-integer scores', () => {
    expect(isLegalGameScore(15, -1, 'best_of_3_to_21', null, null, true)).toBe(false);
    expect(isLegalGameScore(15.5, 2, 'best_of_3_to_21', null, null, true)).toBe(false);
  });

  it('takes the cap from the format rather than assuming 30', () => {
    // 11-point format: cap 20. A stoppage has to be a game still in progress,
    // so the high scores that probe the cap must be deuce, not blowouts —
    // 20-3 was accepted here before and is impossible: that game ended at 11-3.
    expect(isLegalTimeExceededScore(19, 18, 'one_game_11')).toBe(true);   // deuce, under the cap
    expect(isLegalTimeExceededScore(20, 19, 'one_game_11')).toBe(false);  // 20 IS the cap: won
    expect(isLegalTimeExceededScore(21, 3, 'one_game_11')).toBe(false);   // past the cap
    // …and a custom best-of-5-to-15 gets 24, not the preset's 30.
    expect(isLegalTimeExceededScore(23, 22, 'bo3_21', 5, 15)).toBe(true);
    expect(isLegalTimeExceededScore(24, 23, 'bo3_21', 5, 15)).toBe(false); // 24 is that cap
    expect(isLegalTimeExceededScore(25, 3, 'bo3_21', 5, 15)).toBe(false);
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

describe('dbError (RPC guard classification)', () => {
  it('marks the guards a user trips by retrying or using a stale page', () => {
    for (const message of [
      'Match not pending confirmation',
      'A match has already been submitted for this challenge',
      'The submitter cannot confirm their own result',
      'Only a participant can confirm this match',
      'Challenge is not accepted',
      'Walkover not found or not pending',
    ]) {
      const err = dbError({ message });
      expect(isExpectedError(err)).toBe(true);
      // The member still sees exactly what the database said.
      expect(err.message).toBe(message);
    }
  });

  it('keeps data-inconsistency guards reportable — they mean a real bug', () => {
    // A match whose games contradict its recorded winner is not a user mistake;
    // if it ever happens again it must show up in Sentry.
    expect(isExpectedError(dbError({ message: 'winner_side does not match game scores' }))).toBe(false);
    expect(isExpectedError(dbError({ message: 'Games won are tied; cannot derive winner' }))).toBe(false);
    expect(isExpectedError(dbError({ message: 'No decisive games recorded for match' }))).toBe(false);
  });

  // Under RLS a row the caller cannot see comes back as "not found", so
  // filtering this would hide a row-visibility regression — the exact shape of
  // the 00032 fallout.
  it('keeps "not found" reportable, so an RLS regression cannot go dark', () => {
    expect(isExpectedError(dbError({ message: 'Challenge not found' }))).toBe(false);
    expect(isExpectedError(dbError({ message: 'Match not found' }))).toBe(false);
  });

  it('defaults an unrecognised failure to a fault, never a silent pass', () => {
    expect(isExpectedError(dbError({ message: 'permission denied for table players' }))).toBe(false);
    expect(isExpectedError(dbError({ message: 'could not connect to server' }))).toBe(false);
    expect(isExpectedError(dbError(null))).toBe(false);
  });

  it('falls back to a generic message when the error has none', () => {
    expect(dbError(null).message).toBe('Something went wrong');
    expect(dbError({ message: '   ' }, 'Could not save').message).toBe('Could not save');
  });

  it('ignores surrounding whitespace when classifying', () => {
    expect(isExpectedDbGuard('  Match not pending confirmation  ')).toBe(true);
    expect(isExpectedDbGuard('Match not pending confirmation!')).toBe(false);
  });

  // These guards interpolate the offending value, so exact matching can't reach
  // them — they are the most common score-entry mistakes and must not page.
  it('matches the guards that embed runtime values', () => {
    expect(isExpectedDbGuard('Not a possible score for this format: 25-3')).toBe(true);
    expect(isExpectedDbGuard('This match cannot be disputed (status: confirmed)')).toBe(true);
    expect(
      isExpectedDbGuard('A best-of-3 needs 2 game(s) to win and stops there — 1 to 0 is not a possible result')
    ).toBe(true);
    expect(
      isExpectedDbGuard('A single game needs 1 game(s) to win and stops there — 0 to 0 is not a possible result')
    ).toBe(true);
  });

  it('does not let a prefix rule swallow an unrelated failure', () => {
    expect(isExpectedDbGuard('This match cannot be disputed because the server exploded')).toBe(false);
    expect(isExpectedDbGuard('needs a game to win')).toBe(false);
  });
});
