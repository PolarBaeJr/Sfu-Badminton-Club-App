import { describe, it, expect } from 'vitest';
import { eventRecordFor, eventRatingLine, type EventRecordMatch } from '../event-record';

const ME = 'me';

function m(over: Partial<EventRecordMatch> & { id: string }): EventRecordMatch {
  return {
    status: 'completed',
    is_bye: false,
    scores: null,
    round_number: 1,
    bracket_position: 0,
    phase: null,
    round_name: null,
    aId: ME,
    bId: 'them',
    winnerId: ME,
    ...over,
  };
}

describe('eventRecordFor', () => {
  it('counts wins, losses, games and rally points from the entry side', () => {
    const r = eventRecordFor([
      m({ id: '1', scores: [{ a: 21, b: 15 }, { a: 21, b: 18 }] }),
      m({ id: '2', round_number: 2, winnerId: 'x', scores: [{ a: 19, b: 21 }, { a: 21, b: 17 }, { a: 18, b: 21 }], bId: 'x' }),
    ], ME);
    expect(r).toMatchObject({
      played: 2, won: 1, lost: 1, gamesWon: 3, gamesLost: 2,
      pointsFor: 21 + 21 + 19 + 21 + 18, pointsAgainst: 15 + 18 + 21 + 17 + 21,
    });
  });

  it('orients a side-b entry to its own digits', () => {
    const r = eventRecordFor([
      m({ id: '1', aId: 'them', bId: ME, winnerId: ME, scores: [{ a: 15, b: 21 }, { a: 21, b: 19 }, { a: 10, b: 21 }] }),
    ], ME);
    expect(r).toMatchObject({ played: 1, won: 1, lost: 0, gamesWon: 2, gamesLost: 1, pointsFor: 61, pointsAgainst: 46 });
    expect(r.last?.scores).toEqual([{ mine: 21, theirs: 15 }, { mine: 19, theirs: 21 }, { mine: 21, theirs: 10 }]);
    expect(r.last?.opponentId).toBe('them');
  });

  it('never counts a bye, though the generator writes it completed with a winner', () => {
    const r = eventRecordFor([
      m({ id: 'bye', is_bye: true, bId: null, winnerId: ME }),
      m({ id: 'real', round_number: 2, scores: [{ a: 21, b: 3 }] }),
    ], ME);
    expect(r.played).toBe(1);
    expect(r.won).toBe(1);
    expect(r.last?.matchId).toBe('real');
  });

  it('counts nothing that is voided, pending, live or disputed, nor anybody else', () => {
    const r = eventRecordFor([
      m({ id: 'v', status: 'voided' }),
      m({ id: 'p', status: 'pending', winnerId: null }),
      m({ id: 'l', status: 'live', winnerId: null }),
      m({ id: 'd', status: 'disputed' }),
      m({ id: 'o', aId: 'x', bId: 'y', winnerId: 'x' }),
    ], ME);
    expect(r).toEqual({
      played: 0, won: 0, lost: 0, gamesWon: 0, gamesLost: 0, pointsFor: 0, pointsAgainst: 0, last: null,
    });
  });

  it('counts a walkover with no scores as a result and no rallies', () => {
    const r = eventRecordFor([
      m({ id: 'w', status: 'walkover', scores: null, winnerId: 'them' }),
    ], ME);
    expect(r).toMatchObject({ played: 1, won: 0, lost: 1, gamesWon: 0, gamesLost: 0, pointsFor: 0, pointsAgainst: 0 });
    expect(r.last).toMatchObject({ matchId: 'w', won: false, scores: [] });
  });

  it('puts the knockout after the pool although round_number restarts', () => {
    const r = eventRecordFor([
      m({ id: 'pool3', phase: 'pool', round_number: 3 }),
      m({ id: 'qf', phase: 'bracket', round_number: 1, round_name: 'Quarter-Final' }),
      m({ id: 'pool1', phase: 'pool', round_number: 1 }),
    ], ME);
    expect(r.last?.matchId).toBe('qf');
    expect(r.last?.roundName).toBe('Quarter-Final');
  });

  it('breaks a tie on round by bracket position, and names an unnamed round', () => {
    const r = eventRecordFor([
      m({ id: 'p1', round_number: 2, bracket_position: 1 }),
      m({ id: 'p0', round_number: 2, bracket_position: 0 }),
    ], ME);
    expect(r.last?.matchId).toBe('p1');
    expect(r.last?.roundName).toBe('Round 2');
  });

  it('counts the third-place playoff like any other match', () => {
    const r = eventRecordFor([
      m({ id: 'sf', round_number: 2, winnerId: 'them' }),
      m({ id: 'third', round_number: 3, bracket_position: 1, round_name: '3rd Place Playoff', bId: 'other' }),
    ], ME);
    expect(r).toMatchObject({ played: 2, won: 1, lost: 1 });
    expect(r.last).toMatchObject({ matchId: 'third', won: true, opponentId: 'other', roundName: '3rd Place Playoff' });
  });
});

describe('eventRatingLine', () => {
  it('derives the delta from the two ratings when both exist, whatever elo_change says', () => {
    expect(eventRatingLine(1114, 1190, 108)).toEqual({ before: 1114, after: 1190, delta: 76 });
  });

  it('falls back to the stored change, with no arrow, when a rating is missing', () => {
    expect(eventRatingLine(1114, null, 12)).toEqual({ before: null, after: null, delta: 12 });
    expect(eventRatingLine(null, 1190, -5)).toEqual({ before: null, after: null, delta: -5 });
  });

  it('reports no change as a zero, not as nothing', () => {
    expect(eventRatingLine(1200, 1200, null)).toEqual({ before: 1200, after: 1200, delta: 0 });
  });

  it('is null when there is nothing to say', () => {
    expect(eventRatingLine(null, null, null)).toBeNull();
    expect(eventRatingLine(1200, null, null)).toBeNull();
  });
});
