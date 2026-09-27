// ============================================================
// ONE ENTRY'S RECORD IN ONE EVENT
// ============================================================
//
// Counted in two places that must agree: the console's after-score summary
// (getMatchOutcomeSummary in admin tournament-actions/results.ts) and the
// member's own "your event so far" on the player event page. Two copies of
// "what counts as a match played" would drift the first time a status was
// added, and a member reading 3-1 while the desk reads 3-2 is the kind of
// disagreement nobody can settle from either screen.
//
// Nothing in here touches React, the DOM or the database.

/**
 * One match, already resolved to entry ids: a tournament_participants id on a
 * singles event, a tournament_pairs id on a doubles one. The caller spends the
 * `doubles` branch once, when it flattens the rows.
 */
export interface EventRecordMatch {
  id: string;
  status: string;
  is_bye: boolean;
  scores: Array<{ a: number; b: number }> | null;
  round_number: number;
  bracket_position: number;
  phase?: string | null;
  round_name?: string | null;
  aId: string | null;
  bId: string | null;
  winnerId: string | null;
}

export interface EventRecordLast {
  matchId: string;
  opponentId: string | null;
  won: boolean;
  /** Each game from the entry's own side: `mine` is its points, `theirs` the opponent's. */
  scores: Array<{ mine: number; theirs: number }>;
  roundName: string;
}

export interface EventRecord {
  played: number;
  won: number;
  lost: number;
  gamesWon: number;
  gamesLost: number;
  /** Rally points, summed across games. NOT tournament points, which are written at finalise. */
  pointsFor: number;
  pointsAgainst: number;
  last: EventRecordLast | null;
}

const phaseRank = (m: EventRecordMatch) => (m.phase === 'bracket' ? 1 : 0);

/**
 * The entry's record in the matches given.
 *
 * WHAT COUNTS: completed and walkover, never a bye. A bye is written `completed`
 * with the entrant already in the winner column, but nobody played it; a voided
 * match no longer happened. This is the rule the console's after-score summary
 * has always counted by, and `isPlayedMatch` makes the same call on byes.
 *
 * A WALKOVER WITH NO SCORES counts as a win or a loss and adds nothing to games
 * or points: there were no rallies to count.
 *
 * THE LAST MATCH is the latest in play order: the knockout after the pool
 * (round_number restarts at 1 in the bracket of a pool_to_bracket event, so
 * the round alone would put a pool round 3 after a quarter-final), then round,
 * then bracket position.
 */
export function eventRecordFor(matches: EventRecordMatch[], entryId: string): EventRecord {
  const record: EventRecord = {
    played: 0, won: 0, lost: 0, gamesWon: 0, gamesLost: 0, pointsFor: 0, pointsAgainst: 0, last: null,
  };
  let lastMatch: EventRecordMatch | null = null;

  for (const m of matches) {
    if (m.is_bye) continue;
    if (m.status !== 'completed' && m.status !== 'walkover') continue;
    if (m.aId !== entryId && m.bId !== entryId) continue;

    const side = m.aId === entryId ? 'a' : 'b';
    record.played++;
    if (m.winnerId === entryId) record.won++;
    else record.lost++;

    for (const g of m.scores ?? []) {
      const mine = side === 'a' ? g.a : g.b;
      const theirs = side === 'a' ? g.b : g.a;
      if (typeof mine !== 'number' || typeof theirs !== 'number') continue;
      record.pointsFor += mine;
      record.pointsAgainst += theirs;
      if (mine > theirs) record.gamesWon++;
      else if (theirs > mine) record.gamesLost++;
    }

    if (
      !lastMatch
      || phaseRank(m) > phaseRank(lastMatch)
      || (phaseRank(m) === phaseRank(lastMatch) && (
        m.round_number > lastMatch.round_number
        || (m.round_number === lastMatch.round_number && m.bracket_position > lastMatch.bracket_position)
      ))
    ) {
      lastMatch = m;
    }
  }

  if (lastMatch) {
    const side = lastMatch.aId === entryId ? 'a' : 'b';
    record.last = {
      matchId: lastMatch.id,
      opponentId: side === 'a' ? lastMatch.bId : lastMatch.aId,
      won: lastMatch.winnerId === entryId,
      scores: (lastMatch.scores ?? []).map((g) => ({
        mine: side === 'a' ? g.a : g.b,
        theirs: side === 'a' ? g.b : g.a,
      })),
      roundName: lastMatch.round_name || `Round ${lastMatch.round_number}`,
    };
  }
  return record;
}

/**
 * THE RATING LINE, reconciled so its three figures always agree.
 *
 * The delta is derived from the two ratings beside it, not read from elo_change,
 * whenever both exist. They usually agree (applyPlacementBonuses credits
 * elo_change and elo_after together), but the placement bonus is CLAMPED into
 * elo_after and not into elo_change, so at the rating ceiling the stored change
 * can exceed the movement it describes. "1114 -> 1190 (+108)" is exactly the row
 * 00083 and the elo_after fix exist to have stopped appearing.
 *
 * With no elo_after at all (an entry that has been credited but never rated)
 * there is no arrow to draw, so the stored change is returned on its own with
 * `before`/`after` null. Null when there is nothing to say.
 */
export function eventRatingLine(
  before: number | null,
  after: number | null,
  change: number | null,
): { before: number | null; after: number | null; delta: number } | null {
  const hasBoth = before != null && after != null;
  const delta = hasBoth ? after - before : change;
  if (delta == null) return null;
  return { before: hasBoth ? before : null, after: hasBoth ? after : null, delta };
}
