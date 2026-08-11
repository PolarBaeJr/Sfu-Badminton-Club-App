// How many of a tournament's events one member may enter.
//
// "we would be trying to limit people allowing x amount of event allowed" — the
// club owner. A tournament runs several events (singles, doubles, mixed) and
// one strong player entering all of them crowds out the rest of the club.
// `tournaments.max_events_per_player` is the number; NULL means uncapped, which
// is the default and is what every tournament created before this feature is.
//
// This is `tournament_events.max_participants` one level up: that caps a single
// event's field, this caps one person across the whole tournament.
//
// ------------------------------------------------------------
// THE THING THAT MAKES THIS NOT A ROW COUNT
// ------------------------------------------------------------
// A DOUBLES ENTRY DOES NOT CREATE A tournament_participants ROW. It creates a
// tournament_pairs row carrying player1_id and player2_id. So counting
// participants alone lets somebody enter three doubles events under a cap of
// two and never trip it — the cap would be enforced against singles players
// only, which is the population least likely to hit it.
//
// The count is therefore participants PLUS pairs-where-you-are-either-half,
// both scoped to the tournament, and both ignoring entries that are no longer
// in the event.
//
// ------------------------------------------------------------
// WHY A WITHDRAWAL HAS TO GIVE THE SLOT BACK
// ------------------------------------------------------------
// A member at a cap of two who withdraws from one event is entitled to enter
// another; counting their withdrawn entry would lock them out of a tournament
// they are still allowed to be in, and the only way out would be an exec
// deleting the row. Disqualification is excluded for the same structural
// reason — the entry is not in the event any more — and deliberately NOT as a
// judgement about whether a disqualified player deserves another go. That is a
// tournament-desk decision, made by not adding them.
//
// NOTE the asymmetry with max_participants, which is left exactly as it was:
// the admin-side capacity checks exclude only 'withdrawn'. Widening those to
// match would change who fits in an event today, so they are untouched and this
// is the only rule that counts both.

import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * Entry statuses that do NOT occupy one of a member's allowed slots.
 *
 * Everything else does — including 'no_show', which is somebody who took a
 * place in the draw and then did not turn up. That is a slot they used.
 */
export const ENTRY_CAP_RELEASING_STATUSES: readonly string[] = ['withdrawn', 'disqualified'];

/** The shape this needs from a tournament_participants row, and nothing more. */
export interface EntryCapParticipantRow {
  player_id: string;
  status?: string | null;
}

/** The shape this needs from a tournament_pairs row, and nothing more. */
export interface EntryCapPairRow {
  player1_id: string;
  player2_id: string;
  status?: string | null;
}

function stillEntered(status: string | null | undefined): boolean {
  return !ENTRY_CAP_RELEASING_STATUSES.includes(status ?? '');
}

/**
 * How many of this tournament's events each member has taken, by player id.
 *
 * PURE, AND THE ONLY PLACE THIS IS COUNTED. Four entry paths enforce the cap
 * (three in the admin app, one in the player app) and the tournament screen
 * displays it; a second implementation anywhere would be a second answer, and
 * the two would disagree on exactly the case that matters — doubles.
 *
 * ONE MAP RATHER THAN ONE PLAYER'S NUMBER, because the actions want a single
 * entrant's count and the exec's screen wants everybody's, and those are the
 * same computation over different slices of the same two reads.
 *
 * BOTH HALVES OF A PAIR ARE COUNTED, and the row contributes ONE to each of
 * them — never two to either. A player who is somehow both halves of the same
 * row still spends a single slot on it.
 *
 * Absent from the map means zero. Callers read it with `?? 0`.
 *
 * @param participants Singles entries across the tournament's events.
 * @param pairs        Doubles entries across the tournament's events.
 */
export function countEventEntriesPerPlayer(
  participants: readonly EntryCapParticipantRow[],
  pairs: readonly EntryCapPairRow[],
): Map<string, number> {
  const counts = new Map<string, number>();

  const bump = (playerId: string | null | undefined) => {
    if (!playerId) return;
    counts.set(playerId, (counts.get(playerId) ?? 0) + 1);
  };

  for (const row of participants) {
    if (!stillEntered(row.status)) continue;
    bump(row.player_id);
  }

  for (const row of pairs) {
    if (!stillEntered(row.status)) continue;
    // A pair is two entrants who happen to play together. Guarded against the
    // degenerate row where both halves are the same player, which would
    // otherwise charge them two slots for one entry.
    bump(row.player1_id);
    if (row.player2_id !== row.player1_id) bump(row.player2_id);
  }

  return counts;
}

/**
 * Would entering ONE more event put this player over the cap?
 *
 * `cap` is `tournaments.max_events_per_player`: null/undefined is uncapped and
 * always allows. Non-positive caps are treated as uncapped rather than as "bar
 * everyone" — the column CHECK refuses them, so a value that reaches here is
 * corrupt data and refusing every entry in the tournament is the worse failure.
 */
export function isAtEntryCap(count: number, cap: number | null | undefined): boolean {
  if (cap === null || cap === undefined || cap <= 0) return false;
  return count >= cap;
}

/**
 * What the exec (or the member) is told when the cap refuses an entry.
 *
 * Names the person, because the only caller that has more than one entrant to
 * talk about is the pair path, where "at the cap" without a name tells the exec
 * the team is broken but not which half to go and speak to.
 */
export function entryCapRefusal(name: string, cap: number): string {
  return `${name} is already entered in ${cap} ${cap === 1 ? 'event' : 'events'} at this tournament, which is the limit.`;
}

/**
 * Read the whole tournament's entry counts in two queries.
 *
 * ONE HELPER FOR BOTH APPS, on the same shape as ensureEntryFees: takes a
 * client so the admin app can pass its service-role client and the player app
 * its own, and neither has to know how the count is assembled.
 *
 * The pairs read is a SINGLE query over both halves, folded by the pure
 * function above — deliberately not one query on player1_id plus one on
 * player2_id, which double-counts nobody until a pair happens to appear in both
 * result sets and then double-counts them silently.
 *
 * THROWS on a failed read, unlike ensureEntryFees. Opposite situation: this is
 * called BEFORE the entry is written, and a swallowed error here would read as
 * "this member has entered nothing" and wave them past the cap. Refusing the
 * add is recoverable; a cap that fails open is not.
 */
export async function loadTournamentEntryCounts(
  supabase: SupabaseClient,
  tournamentId: string,
): Promise<Map<string, number>> {
  // !inner on the event join, so the filter on the tournament actually
  // restricts the rows rather than nulling the embed — the same shape
  // acceptEventWaiver already uses to ask this question for one player.
  const [participantsRes, pairsRes] = await Promise.all([
    supabase
      .from('tournament_participants')
      .select('player_id, status, event:tournament_events!inner(tournament_id)')
      .eq('tournament_events.tournament_id', tournamentId),
    supabase
      .from('tournament_pairs')
      .select('player1_id, player2_id, status, event:tournament_events!inner(tournament_id)')
      .eq('tournament_events.tournament_id', tournamentId),
  ]);

  if (participantsRes.error) throw participantsRes.error;
  if (pairsRes.error) throw pairsRes.error;

  return countEventEntriesPerPlayer(
    (participantsRes.data ?? []) as EntryCapParticipantRow[],
    (pairsRes.data ?? []) as EntryCapPairRow[],
  );
}
