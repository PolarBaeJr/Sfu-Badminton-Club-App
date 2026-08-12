// A DOUBLES EVENT IS A POOL: some entrants arrive already paired, some arrive
// alone and are paired later.
//
// "there can be doubles people joining the event as a group, and as a single
// person — if they are paired then they keep their pair, if they are not
// assigned then they get assigned" — the club owner.
//
// The shape (migration 00102):
//
//     tournament_participants  = a PERSON in the event's pool
//     tournament_pairs         = a TEAM that has been formed
//
// so an unpaired entrant is an ordinary participant row in a doubles event, and
// pairing PROMOTES two of them into one pair row. Nothing that already reads
// pairs has to learn a new case — a pair still always has two players.
//
// ---------------------------------------------------------------------------
// THE WORD "POOL" IS OVERLOADED IN THIS CODEBASE — read this before renaming
// ---------------------------------------------------------------------------
// tournament_events.seeded_from_event_id and buildFieldFromPool() in the admin
// app already mean "seed this bracket from ANOTHER EVENT's round-robin
// standings". That is a completely different pool. Everything here says
// UNPAIRED, and the admin actions say `unpaired` too, precisely so the two
// never get confused in a file that touches both.
//
// This module is pure and has no database access, for the reason
// tournament-entry-cap.ts gives about itself: the slot arithmetic is enforced
// in the admin app and displayed in two others, and a second implementation
// would be a second answer to "is this event full".

/** Statuses that mean an entry is no longer in the event. */
const GONE: readonly string[] = ['withdrawn', 'disqualified'];

/** The shape this needs from a tournament_participants row, and nothing more. */
export interface UnpairedEntrantRow {
  player_id: string;
  status?: string | null;
}

/** The shape this needs from a tournament_pairs row, and nothing more. */
export interface FormedPairRow {
  player1_id: string;
  player2_id: string;
  status?: string | null;
}

/** Is this entry still in the event? */
export function stillInEvent(status: string | null | undefined): boolean {
  return !GONE.includes(status ?? '');
}

/**
 * How many DRAW SLOTS a doubles field currently accounts for.
 *
 * `tournament_events.max_participants` has always meant "how many entries fit
 * in this event", and for doubles an entry is a TEAM — the admin capacity check
 * counted tournament_pairs rows and nothing else. Unpaired entrants have to be
 * counted in the same currency or the number stops meaning anything: eight
 * pairs and forty loose people is not an event with room for two more.
 *
 * So two unpaired entrants amount to ONE prospective team, rounded UP because a
 * single loose person still needs a partner and therefore still needs a slot.
 *
 * THE PROPERTY THAT MAKES THIS SAFE, and the one the test pins:
 *
 *   * with no unpaired entrants it returns exactly `pairs`, so not one existing
 *     doubles event's capacity moves; and
 *   * PAIRING IS SLOT-NEUTRAL. Promotion turns 2 unpaired into 1 pair:
 *     pairs + ceil(u/2)  ->  (pairs + 1) + ceil((u - 2)/2), which is the same
 *     number for every u >= 2, odd or even. An exec can never be told the event
 *     is full by an operation that added nobody to it.
 */
export function doublesDrawSlots(pairs: number, unpaired: number): number {
  return Math.max(pairs, 0) + Math.ceil(Math.max(unpaired, 0) / 2);
}

/** Count the pairs and unpaired entrants that are still in the event. */
export function countDoublesField(
  unpairedRows: readonly UnpairedEntrantRow[],
  pairRows: readonly FormedPairRow[],
): { unpaired: number; pairs: number; slots: number } {
  const unpaired = unpairedRows.filter((r) => stillInEvent(r.status)).length;
  const pairs = pairRows.filter((r) => stillInEvent(r.status)).length;
  return { unpaired, pairs, slots: doublesDrawSlots(pairs, unpaired) };
}

/**
 * Does this operation put the event over `max_participants`?
 *
 * Compares the field BEFORE and AFTER rather than testing the new number alone.
 * An event that is already over its own limit — the limit was lowered, or rows
 * predate it — must not have a slot-NEUTRAL operation like pairing refused,
 * because refusing it leaves the event exactly as over-full as it was and takes
 * away the only tidying-up the exec can do.
 */
export function wouldExceedCapacity(
  slotsBefore: number,
  slotsAfter: number,
  max: number | null | undefined,
): boolean {
  if (max === null || max === undefined || max <= 0) return false;
  return slotsAfter > max && slotsAfter > slotsBefore;
}

// ---------------------------------------------------------------------------
// AUTO PAIR — turning a waiting list into teams in one press
// ---------------------------------------------------------------------------
// An exec pairs entrants two at a time by ticking checkboxes. With six people
// waiting that is three round trips of hand-picking, on the day of an event.
//
// THE STRATEGY IS BALANCED TEAMS: the sorted list is FOLDED, so the strongest
// player partners the weakest, the second strongest the second weakest, and so
// on. The alternative — pairing adjacent by rating, so similar players play
// together — was rejected, and the two produce very different draws:
//
//   adjacent  makes every TEAM internally similar and the FIELD lopsided. The
//             top two players form one team that outclasses the bracket, and
//             the first round is decided before it is played.
//   folded    makes every TEAM's combined rating close to every other's, which
//             is the number the bracket is actually seeded on (combined_elo).
//
// For a club draw the second is the better shape: it is a social event where
// the point is competitive matches, not an accurate ranking of the entrants.
// It also mixes strong players with weak ones, which is how a club gets its
// beginners playing with its regulars instead of beside them.
//
// DETERMINISM IS A REQUIREMENT, not a nicety: the exec may press this, look at
// the result, unpair everybody and press it again, and getting a different
// answer the second time reads as a broken button. Rating alone does NOT order
// this list — `elo_before ?? 400` and the pool's own COALESCE(..., 400) mean a
// whole cohort of new entrants sits at exactly 400 — so player_id is the
// tiebreaker, and the sort happens HERE rather than in the query. PostgREST
// returns tied rows in whatever order Postgres picks, so ordering in SQL would
// leave the fold reading a list that is only mostly sorted.

/** One person waiting for a partner, and the rating they are folded on. */
export interface AutoPairCandidate {
  playerId: string;
  /** doubles_elo, or the 400 default the pool itself uses. */
  rating: number;
}

export interface AutoPairPlan {
  /** Teams to form, strongest-with-weakest. */
  pairs: Array<[string, string]>;
  /**
   * The one person an odd-sized list cannot seat, or null.
   *
   * It is the MEDIAN entrant, and that falls out of the fold rather than being
   * chosen: pairing inward from both ends leaves the middle. Leaving out the
   * WEAKEST instead would have been a judgement about who matters least, made
   * silently by a button — this way the leftover is whoever the arithmetic
   * happens to reach last. They stay in the pool either way, and the caller
   * says so out loud rather than dropping them.
   */
  leftOver: string | null;
}

/**
 * Fold a waiting list into balanced teams. Pure, total, and deterministic for
 * any input order — the test pins that by shuffling.
 */
export function planAutoPairs(candidates: readonly AutoPairCandidate[]): AutoPairPlan {
  const sorted = [...candidates].sort(
    (a, b) => b.rating - a.rating || (a.playerId < b.playerId ? -1 : a.playerId > b.playerId ? 1 : 0),
  );

  const pairs: Array<[string, string]> = [];
  let strongest = 0;
  let weakest = sorted.length - 1;
  while (strongest < weakest) {
    pairs.push([sorted[strongest]!.playerId, sorted[weakest]!.playerId]);
    strongest += 1;
    weakest -= 1;
  }

  return { pairs, leftOver: strongest === weakest ? sorted[strongest]!.playerId : null };
}

/**
 * What the exec is told when a draw is asked for with people still loose.
 *
 * REFUSING IS THE ONLY DEFENSIBLE ANSWER of the three available. Auto-pairing
 * them assigns partners nobody agreed to, at the moment it is hardest to
 * change; dropping them silently produces a bracket that LOOKS complete, with
 * skips where people should be, and the exec finds out when somebody turns up
 * for a match that was never created. So the draw stops and NAMES them, which
 * is the one thing that lets an exec fix it in the ten seconds they have.
 *
 * Both remedies are offered because both are real: pair them up, or take them
 * out. Same sentence shape as the event-waiver draw refusal, which is the other
 * thing that stops a bracket for a reason the exec has to resolve by hand.
 */
export function unpairedDrawRefusal(names: readonly string[]): string {
  if (names.length === 0) return '';
  const one = names.length === 1;
  const who = one
    ? `${names[0]} has entered this doubles event without a partner`
    : `${names.join(', ')} have entered this doubles event without a partner`;
  const remedy = one ? 'pair them with somebody' : 'pair them up';
  return `${who}. The draw was not generated — ${remedy}, or take them out of the event first.`;
}
