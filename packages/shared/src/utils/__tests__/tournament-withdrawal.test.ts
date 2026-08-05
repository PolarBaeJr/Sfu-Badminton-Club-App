import { describe, it, expect } from 'vitest';
import {
  eventHasDraw,
  isOutOfEvent,
  isOpenMatch,
  forfeitOutcome,
  OPEN_MATCH_STATUSES,
} from '../tournament-withdrawal';

describe('eventHasDraw', () => {
  it('is false before a bracket exists', () => {
    expect(eventHasDraw('registration')).toBe(false);
    expect(eventHasDraw('checkin')).toBe(false);
  });

  // The cut-off is bracket generation, NOT the event going live: the draw is
  // published a whole status earlier, and that is the moment a withdrawal
  // starts changing someone else's match.
  it('is true from bracket generation onwards', () => {
    expect(eventHasDraw('bracket_generated')).toBe(true);
    expect(eventHasDraw('live')).toBe(true);
    expect(eventHasDraw('completed')).toBe(true);
  });

  it('treats a missing status as no draw', () => {
    expect(eventHasDraw(null)).toBe(false);
    expect(eventHasDraw(undefined)).toBe(false);
    expect(eventHasDraw('')).toBe(false);
  });
});

describe('isOutOfEvent', () => {
  it('covers both exits from the draw', () => {
    expect(isOutOfEvent('withdrawn')).toBe(true);
    expect(isOutOfEvent('disqualified')).toBe(true);
  });

  it('leaves everyone still entered alone', () => {
    expect(isOutOfEvent('registered')).toBe(false);
    expect(isOutOfEvent('checked_in')).toBe(false);
    expect(isOutOfEvent(null)).toBe(false);
  });

  // A no-show is recorded at check-in and feeds bracket generation; it does not
  // contradict a draw the way a late withdrawal does.
  it('does not treat a no-show as out of the draw', () => {
    expect(isOutOfEvent('no_show')).toBe(false);
  });
});

describe('isOpenMatch', () => {
  it('accepts only the still-playable statuses', () => {
    for (const s of OPEN_MATCH_STATUSES) expect(isOpenMatch(s)).toBe(true);
  });

  // Forfeiting one of these would rewrite a result that already moved Elo.
  it('rejects anything that already has a result', () => {
    expect(isOpenMatch('completed')).toBe(false);
    expect(isOpenMatch('walkover')).toBe(false);
    expect(isOpenMatch('voided')).toBe(false);
    expect(isOpenMatch('disputed')).toBe(false);
    expect(isOpenMatch(null)).toBe(false);
  });
});

describe('forfeitOutcome', () => {
  it('awards side b when the a-side entry forfeits', () => {
    const match = { participant_a_id: 'p1', participant_b_id: 'p2' };
    expect(forfeitOutcome(match, 'p1', false)).toEqual({
      entrySide: 'a',
      winnerSide: 'b',
      winnerId: 'p2',
    });
  });

  it('awards side a when the b-side entry forfeits', () => {
    const match = { participant_a_id: 'p1', participant_b_id: 'p2' };
    expect(forfeitOutcome(match, 'p2', false)).toEqual({
      entrySide: 'b',
      winnerSide: 'a',
      winnerId: 'p1',
    });
  });

  it('reads the pair columns for doubles', () => {
    const match = { pair_a_id: 'x', pair_b_id: 'y', participant_a_id: 'p1', participant_b_id: 'p2' };
    expect(forfeitOutcome(match, 'y', true)).toEqual({
      entrySide: 'b',
      winnerSide: 'a',
      winnerId: 'x',
    });
    // The singles columns on the same row must not leak into a doubles read.
    expect(forfeitOutcome(match, 'p1', true)).toBeNull();
  });

  // The opponent's feeder match has not finished, so there is nobody to hand
  // the walkover to yet. Callers must defer rather than advance a null.
  it('reports a null winner when the opposing slot is still TBD', () => {
    const match = { participant_a_id: 'p1', participant_b_id: null };
    expect(forfeitOutcome(match, 'p1', false)).toEqual({
      entrySide: 'a',
      winnerSide: 'b',
      winnerId: null,
    });
  });

  it('returns null when the entry is not in the match', () => {
    const match = { participant_a_id: 'p1', participant_b_id: 'p2' };
    expect(forfeitOutcome(match, 'p3', false)).toBeNull();
  });

  it('returns null for an empty match shell', () => {
    expect(forfeitOutcome({}, 'p1', false)).toBeNull();
  });
});
