import { describe, it, expect } from 'vitest';
import {
  eventHasDraw,
  isOutOfEvent,
  isOpenMatch,
  forfeitOutcome,
  OPEN_MATCH_STATUSES,
  isPlayedMatch,
  RESULT_MATCH_STATUSES,
  isInProgressMatch,
  carriesAppliedRating,
  summariseRedrawBlockers,
  hasRedrawBlockers,
  isRealIncompleteMatch,
  classifyEventForCompletion,
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

describe('isPlayedMatch — the one definition of "somebody played this"', () => {
  // THE DEFECT THIS EXISTS TO STOP HAPPENING TWICE. Generation writes
  // status:'completed' onto every bye, and the redraw guard counted exactly
  // that set of statuses — so every field that is not a power of two produced a
  // draw the guard called "results already entered", about matches with no
  // score, no Elo and no opponent to void. The guard was fixed; putting the
  // rule here is what stops the event page reinventing it wrongly one layer up.
  it('does not count a bye, however completed it says it is', () => {
    expect(isPlayedMatch({ status: 'completed', is_bye: true })).toBe(false);
  });

  it('counts a real completed match', () => {
    expect(isPlayedMatch({ status: 'completed', is_bye: false })).toBe(true);
  });

  // A WALKOVER IS A RESULT even though nobody played: recordWalkover rates it,
  // and going live records real ones for anybody who withdrew after the draw
  // was published. Rebuilding the draw over one would erase Elo that has moved.
  it('counts a walkover and a disputed result', () => {
    expect(isPlayedMatch({ status: 'walkover', is_bye: false })).toBe(true);
    expect(isPlayedMatch({ status: 'disputed', is_bye: null })).toBe(true);
  });

  // NOT the complement of OPEN_MATCH_STATUSES. Voiding takes the result and its
  // Elo back off, so a voided match is history that no longer counts — and it
  // is the remedy the redraw's refusal points the exec at, so it has to be
  // false here or that remedy does nothing.
  it('does not count a voided match, or one nobody has reached yet', () => {
    for (const status of ['voided', 'pending', 'ready', 'live']) {
      expect(isPlayedMatch({ status, is_bye: false }), status).toBe(false);
    }
  });

  // is_bye is `BOOLEAN DEFAULT false` and nullable (00001), and nothing writes
  // it on a non-bye match. Treating null as "might be a bye" would exclude
  // every real match and make the count vacuous — the same shape of failure,
  // from the other side.
  it('treats a null or missing is_bye as not-a-bye', () => {
    expect(isPlayedMatch({ status: 'completed', is_bye: null })).toBe(true);
    expect(isPlayedMatch({ status: 'completed' })).toBe(true);
  });

  it('says nothing about a status it has never heard of', () => {
    expect(isPlayedMatch({ status: 'retired' })).toBe(false);
    expect(isPlayedMatch({})).toBe(false);
  });

  it('lists the three statuses the server guard filters on', () => {
    // The server cannot call isPlayedMatch — its half is a PostgREST `.in()`
    // filter — so the list itself is what is shared, and this is what keeps the
    // two halves the same list.
    expect([...RESULT_MATCH_STATUSES]).toEqual(['completed', 'walkover', 'disputed']);
    for (const status of RESULT_MATCH_STATUSES) {
      expect(isPlayedMatch({ status }), status).toBe(true);
    }
  });

  // Every match is exactly one of: open, played, or voided. A status that is
  // neither open nor played nor voided would be a row the console has no
  // opinion about — invisible to the redraw guard and to the forfeit sweep at
  // once. The schema's CHECK constraint lists exactly these seven.
  it('partitions every status the schema allows', () => {
    const ALL = ['pending', 'ready', 'live', 'completed', 'walkover', 'disputed', 'voided'];
    for (const status of ALL) {
      const open = isOpenMatch(status);
      const played = isPlayedMatch({ status });
      expect(open && played, status).toBe(false);
      expect(open || played || status === 'voided', status).toBe(true);
    }
  });
});

describe('summariseRedrawBlockers — what a redraw would destroy', () => {
  it('counts a result exactly as isPlayedMatch does, byes excluded', () => {
    const b = summariseRedrawBlockers([
      { status: 'completed', is_bye: false },
      { status: 'walkover', is_bye: false },
      { status: 'disputed', is_bye: null },
      { status: 'completed', is_bye: true },
      { status: 'pending', is_bye: false },
    ]);
    expect(b).toEqual({ played: 3, rated: 0, inProgress: 0 });
  });

  it('counts a LIVE match, which isPlayedMatch does not and must not', () => {
    // The whole of harm (a). A live match has no score and no Elo, so it is
    // rightly not a result — but redrawing deletes it out from under the people
    // on court, and the button stayed pressable because nothing counted it.
    expect(isInProgressMatch({ status: 'live', is_bye: false })).toBe(true);
    expect(isPlayedMatch({ status: 'live', is_bye: false })).toBe(false);
    const b = summariseRedrawBlockers([
      { status: 'live', is_bye: false },
      { status: 'live' },
      { status: 'ready', is_bye: false },
    ]);
    expect(b).toEqual({ played: 0, rated: 0, inProgress: 2 });
  });

  it('a bye is never in progress', () => {
    // Nothing generates a live bye, but the null-safety is the same rule
    // isPlayedMatch follows and it should not depend on that staying true.
    expect(isInProgressMatch({ status: 'live', is_bye: true })).toBe(false);
  });

  it('counts an unreversed rating on a row whose status says otherwise', () => {
    // Production holds rows in this shape: a void racing a result entry, from
    // when voidMatchImpl wrote status on the id alone. That race is closed now,
    // but the rows it already made are not going anywhere. Deleting one puts a
    // rating on the ladder that reverse_tournament_match_rating can never take
    // back, because the snapshot it reads went with the row.
    const b = summariseRedrawBlockers([
      { status: 'voided', is_bye: false, elo_snapshot: { discipline: 'singles', entries: [] } },
      { status: 'voided', is_bye: false, elo_snapshot: null },
      { status: 'pending', is_bye: false },
    ]);
    expect(b).toEqual({ played: 0, rated: 1, inProgress: 0 });
  });

  it('does NOT count a properly voided match — the escape hatch has to work', () => {
    // reverse_tournament_match_rating nulls elo_snapshot in the same transaction
    // as the reversal (00078). If a voided match still blocked, "void those
    // matches first" — the only remedy the refusal offers — would lead nowhere
    // and the draw would be permanently unregenerable.
    expect(carriesAppliedRating({ status: 'voided', elo_snapshot: null })).toBe(false);
    expect(carriesAppliedRating({ status: 'voided' })).toBe(false);
    expect(hasRedrawBlockers(summariseRedrawBlockers([
      { status: 'voided', is_bye: false, elo_snapshot: null },
      { status: 'voided', is_bye: false },
    ]))).toBe(false);
  });

  it('never reports the same match twice', () => {
    // A rated `completed` match is the NORMAL case, and it is one blocker, not
    // two. Double-counting would tell an exec to void two matches when there is
    // one, on a screen where the number is the only actionable part.
    const b = summariseRedrawBlockers([
      { status: 'completed', is_bye: false, elo_snapshot: { discipline: 'singles', entries: [] } },
    ]);
    expect(b).toEqual({ played: 1, rated: 0, inProgress: 0 });
  });

  it('is clean on the ordinary unplayed draw, byes and all', () => {
    // The common case, and the one a false positive would break: every draw
    // whose field is not a power of two carries byes written `completed`.
    const b = summariseRedrawBlockers([
      { status: 'pending', is_bye: false },
      { status: 'ready', is_bye: false },
      { status: 'completed', is_bye: true },
      { status: 'completed', is_bye: true },
    ]);
    expect(hasRedrawBlockers(b)).toBe(false);
  });

  it('reads a caller that did not select elo_snapshot as unrated', () => {
    // Which is why the server guard names the column in its projection. Stated
    // as a test so the behaviour is deliberate rather than discovered.
    expect(carriesAppliedRating({ status: 'completed' })).toBe(false);
  });
});

describe('isRealIncompleteMatch — what finalizeEvent counts', () => {
  // A knockout drawn to the next power of two leaves rows with neither side
  // filled whenever the field is not one. They are not matches anybody is
  // waiting to play, and counting them would make those events unfinishable.
  it('does not count an unused bracket slot', () => {
    expect(
      isRealIncompleteMatch({ status: 'pending', participant_a_id: null, participant_b_id: null }, false),
    ).toBe(false);
  });

  it('counts a pending match that has somebody in it', () => {
    expect(
      isRealIncompleteMatch({ status: 'pending', participant_a_id: 'p1', participant_b_id: null }, false),
    ).toBe(true);
  });

  // The transposition this catches is invisible on any fixture where both
  // column families are populated, which is every fixture anybody writes by
  // hand — a doubles row only ever carries pair ids, and a singles row only
  // ever carries participant ids.
  it('reads the pair columns on a doubles event and the participant columns otherwise', () => {
    expect(isRealIncompleteMatch({ status: 'pending', pair_a_id: 'x' }, true)).toBe(true);
    expect(isRealIncompleteMatch({ status: 'pending', pair_a_id: 'x' }, false)).toBe(false);
  });

  it('does not count a settled match, and a disputed one is not settled', () => {
    for (const status of ['completed', 'walkover', 'voided', 'bye']) {
      expect(isRealIncompleteMatch({ status, participant_a_id: 'p1' }, false), status).toBe(false);
    }
    expect(isRealIncompleteMatch({ status: 'disputed', participant_a_id: 'p1' }, false)).toBe(true);
  });

  it('does not count a bye', () => {
    expect(
      isRealIncompleteMatch({ status: 'pending', is_bye: true, participant_a_id: 'p1' }, false),
    ).toBe(false);
  });
});

describe('classifyEventForCompletion — which of the three things happens to this event', () => {
  // THE (a)/(c) BOUNDARY, and the assertion that proves the predicate is
  // genuinely shared with finalizeEvent: a re-implementation that forgets the
  // empty-slot clause flips this pair, and the console would then refuse to
  // complete any event whose field was not a power of two.
  it('finalises a live event whose only open rows are empty slots', () => {
    expect(
      classifyEventForCompletion(
        'live', [{ status: 'pending', participant_a_id: null, participant_b_id: null }], false,
      ).bucket,
    ).toBe('finalisable');
    expect(
      classifyEventForCompletion(
        'live', [{ status: 'pending', participant_a_id: 'p1', participant_b_id: null }], false,
      ).bucket,
    ).toBe('part_played');
  });

  // THE (b)/(c) BOUNDARY. A generated bracket nobody has touched has the same
  // played/rated/in-progress counts as a registration nobody entered; only the
  // incomplete count tells them apart, and only one of them may be closed
  // without asking.
  it('will not silently close a full draw nobody has played yet', () => {
    expect(
      classifyEventForCompletion(
        'bracket_generated', [{ status: 'pending', participant_a_id: 'p1' }], false,
      ).bucket,
    ).toBe('part_played');
    expect(classifyEventForCompletion('bracket_generated', [], false).bucket).toBe('unplayed');
  });

  // finalizeEvent throws 'Event must be live to finalize' before it reads a
  // single match, so no pool status can ever be handed to it.
  it('never finalises a pool status however clean it looks', () => {
    expect(classifyEventForCompletion('pool_live', [], false).bucket).toBe('unplayed');
    expect(classifyEventForCompletion('pool_generated', [], false).bucket).toBe('unplayed');
  });

  it('blocks on a disputed match — it has no settled result', () => {
    const c = classifyEventForCompletion('live', [{ status: 'disputed', participant_a_id: 'p1' }], false);
    expect(c.bucket).toBe('part_played');
    expect(c.incomplete).toBe(1);
    expect(c.played).toBe(1);
  });

  it('counts what a forced close would be abandoning', () => {
    const c = classifyEventForCompletion('live', [
      { status: 'completed', participant_a_id: 'p1', participant_b_id: 'p2' },
      { status: 'live', participant_a_id: 'p3', participant_b_id: 'p4' },
      { status: 'pending', participant_a_id: 'p5', participant_b_id: null },
      { status: 'completed', is_bye: true },
    ], false);
    expect(c).toEqual({ incomplete: 2, played: 1, rated: 0, inProgress: 1, bucket: 'part_played' });
  });
});
