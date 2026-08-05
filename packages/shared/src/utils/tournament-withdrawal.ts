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
