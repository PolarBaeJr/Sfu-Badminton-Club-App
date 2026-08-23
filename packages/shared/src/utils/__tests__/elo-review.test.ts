import { describe, it, expect } from 'vitest';
import { parseEloReview, eloReviewLabel } from '../elo-review';

// The contract this file pins is "never throw, never lie". The column is jsonb
// written by SQL and read on the roster page, so a shape nobody anticipated has
// to come back as "nothing to review" rather than take the page down.
describe('parseEloReview', () => {
  const selfPlay = {
    state: 'elo',
    at: '2026-08-23T11:25:20Z',
    merged_from: 'c0bced90-4a39-4e8b-b1b5-ae8a75bdb517',
    merged_from_name: 'wui KI Cheng',
    self_play_matches: ['e1931dd0-c09a-4da9-91a1-d4cbda8564bb'],
    self_play_tournament_matches: [],
    discarded: { season_final_ratings: 2 },
  };

  it('reads a review written by merge_players', () => {
    const r = parseEloReview(selfPlay);
    expect(r?.state).toBe('elo');
    expect(r?.selfPlayMatches).toHaveLength(1);
    expect(r?.mergedFromName).toBe('wui KI Cheng');
    expect(r?.discarded).toEqual({ season_final_ratings: 2 });
  });

  it.each([null, undefined, 42, 'elo', [], [{ state: 'elo' }]])(
    'returns null rather than throwing for %p',
    (input) => {
      expect(parseEloReview(input)).toBeNull();
    },
  );

  it('returns null for a flag that parses but describes nothing', () => {
    // Matters because it means an admin can clear the badge by writing an empty
    // review; clearing the column is not the only way out.
    expect(parseEloReview({ state: 'elo', self_play_matches: [], discarded: {} })).toBeNull();
  });

  it('re-derives state instead of trusting it', () => {
    // SQL says discards, the matches say otherwise. The matches win — a rating
    // in question must never be downgraded by a stale or hand-edited label.
    const r = parseEloReview({ ...selfPlay, state: 'discards' });
    expect(r?.state).toBe('elo');
  });

  it('calls it discards when only rows were dropped', () => {
    const r = parseEloReview({ ...selfPlay, self_play_matches: [], self_play_tournament_matches: [] });
    expect(r?.state).toBe('discards');
  });

  it('drops non-string ids and non-positive counts', () => {
    // Both would otherwise reach a key prop and a "0 rows discarded" line.
    const r = parseEloReview({
      ...selfPlay,
      self_play_matches: ['ok', 7, null, ''],
      discarded: { a: 2, b: 0, c: -1, d: 'many' },
    });
    expect(r?.selfPlayMatches).toEqual(['ok']);
    expect(r?.discarded).toEqual({ a: 2 });
  });

  it('counts bracket self-play towards an elo review', () => {
    const r = parseEloReview({
      ...selfPlay,
      self_play_matches: [],
      self_play_tournament_matches: ['f50f4444-8b48-4f2f-b80b-eaa4f26a0c7a'],
    });
    expect(r?.state).toBe('elo');
  });

  it('tolerates missing optional fields', () => {
    const r = parseEloReview({ self_play_matches: ['x'] });
    expect(r?.at).toBeNull();
    expect(r?.mergedFrom).toBeNull();
    expect(r?.discarded).toEqual({});
  });
});

describe('eloReviewLabel', () => {
  it('counts both kinds of self-play and singularises', () => {
    const one = parseEloReview({ self_play_matches: ['a'] })!;
    expect(eloReviewLabel(one)).toBe('Elo review — 1 self-play match');
    const two = parseEloReview({ self_play_matches: ['a'], self_play_tournament_matches: ['b'] })!;
    expect(eloReviewLabel(two)).toBe('Elo review — 2 self-play matches');
  });

  it('sums discarded rows when no rating is in question', () => {
    const r = parseEloReview({ discarded: { x: 2, y: 3 } })!;
    expect(eloReviewLabel(r)).toBe('Merge review — 5 rows discarded');
  });
});
