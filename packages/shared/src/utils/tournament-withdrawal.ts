// Withdrawing once a draw exists.
//
// Bracket generation reads entry status ONCE, at the moment it runs. Every
// withdrawal after that is invisible to it: the entry stays seeded, the match
// it sits in stays playable, and the bye it may have been handed stays on the
// record. The rules below are the decisions that make a late withdrawal
// coherent again, and they live here because the player app (which refuses the
// withdrawal) and the admin app (which performs it) must not drift apart on
// where the cut-off is.

// A draw exists from the moment the bracket is generated — one step BEFORE the
// event goes live. 'bracket_generated' is deliberately on this list: the draw
// is published and players have already been told who they play.
const DRAWN_EVENT_STATUSES = new Set<string>(['bracket_generated', 'live', 'completed']);

export function eventHasDraw(eventStatus: string | null | undefined): boolean {
  return !!eventStatus && DRAWN_EVENT_STATUSES.has(eventStatus);
}

// The two statuses that take an entry OUT of the event. 'no_show' is not one of
// them — a no-show is marked at check-in, before a draw exists, and it feeds
// bracket generation rather than contradicting it.
const OUT_OF_EVENT_STATUSES = new Set<string>(['withdrawn', 'disqualified']);

export function isOutOfEvent(entryStatus: string | null | undefined): boolean {
  return !!entryStatus && OUT_OF_EVENT_STATUSES.has(entryStatus);
}

// Match statuses that still resolve to something someone could turn up and
// play. Anything else already has a result (or was voided) and is history —
// a late withdrawal must never rewrite it.
export const OPEN_MATCH_STATUSES = ['pending', 'ready', 'live'] as const;

export function isOpenMatch(matchStatus: string | null | undefined): boolean {
  return (OPEN_MATCH_STATUSES as readonly string[]).includes(matchStatus ?? '');
}

// ------------------------------------------------------------
// "SOMETHING HAS BEEN PLAYED HERE" — ONE DEFINITION, TWO CALLERS
// ------------------------------------------------------------
//
// NOT the complement of OPEN_MATCH_STATUSES. 'voided' is neither: a voided
// match has had its result and its Elo taken back off, so it is history that
// no longer counts, and it must not block a redraw.
//
// It lives in shared because two places now have to agree on it and they are in
// different processes. The server guard (admin tournament-actions/brackets.ts,
// assertNoResultsEntered) refuses to rebuild a draw over a result; the event
// page counts the same thing to decide whether to grey the Regenerate button
// and say why. If those two definitions drift, the console either offers a
// button that always refuses or greys one that would have worked.
//
// AND THE COUNT ON THE PAGE IS NOT THE ONE ALREADY THERE. EventControlCenter's
// `completedMatches` is `status === 'completed' || status === 'walkover' ||
// is_bye` — the progress figure, which counts a bye because a bye is a slot
// that no longer needs a court. Gating the redraw on that number would have
// reproduced, in the client, the exact bye defect the server guard was fixed
// for: every draw whose field is not a power of two would show the button
// greyed for matches nobody played.
export const RESULT_MATCH_STATUSES = ['completed', 'walkover', 'disputed'] as const;

export interface PlayableMatch {
  status?: string | null;
  is_bye?: boolean | null;
}

/**
 * Has this match been decided by something that happened?
 *
 * A BYE IS NOT A RESULT. Generation writes `status: 'completed'` onto a bye
 * because it has already been decided — its winner advances with nothing to
 * play — so the status alone cannot be trusted. There is no score, no Elo and
 * no opponent, and nothing about a bye is evidence that anybody turned up.
 *
 * A WALKOVER IS. It is rated (recordWalkover -> applyTournamentMatchElo), and
 * going live records real ones for anybody who withdrew after the draw was
 * published, so it carries exactly the consequences a played match carries.
 */
export function isPlayedMatch(match: PlayableMatch): boolean {
  if (match.is_bye === true) return false;
  return (RESULT_MATCH_STATUSES as readonly string[]).includes(match.status ?? '');
}

export interface ForfeitableMatch {
  participant_a_id?: string | null;
  participant_b_id?: string | null;
  pair_a_id?: string | null;
  pair_b_id?: string | null;
}

export interface ForfeitOutcome {
  /** Side the forfeiting entry occupies. */
  entrySide: 'a' | 'b';
  /** Side that is awarded the walkover. */
  winnerSide: 'a' | 'b';
  /**
   * Entry awarded the walkover, or null when that slot is still TBD — the
   * feeder match has not finished, so there is nobody to award it to yet.
   */
  winnerId: string | null;
}

/**
 * Work out how `entryId` forfeiting resolves `match`.
 * Returns null when the entry is not in the match at all.
 */
export function forfeitOutcome(
  match: ForfeitableMatch,
  entryId: string,
  doubles: boolean,
): ForfeitOutcome | null {
  const sideA = doubles ? match.pair_a_id : match.participant_a_id;
  const sideB = doubles ? match.pair_b_id : match.participant_b_id;

  if (sideA === entryId) return { entrySide: 'a', winnerSide: 'b', winnerId: sideB ?? null };
  if (sideB === entryId) return { entrySide: 'b', winnerSide: 'a', winnerId: sideA ?? null };
  return null;
}
