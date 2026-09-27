import { courtLabel, eventHasDraw, eventIsPlaying, isPlayedMatch } from '@badminton/shared';

// ---------------------------------------------------------------------------
// THE DESK'S WORKING LIST, worked out once for the two screens that show it:
// the Court Management tab, and the live strip above the event's tabs. Both
// have to agree about which match is next and how many are on court, and two
// copies of that rule would drift the first time either was touched.
//
// Nothing in here touches React, the DOM or the database.
// ---------------------------------------------------------------------------

/**
 * The three states an unplayed match can be in, which is the whole information
 * content of the desk.
 *
 *   live     BEING PLAYED RIGHT NOW. Occupying a court, so it is what the desk
 *            needs to know about before anything else, and, until 00136, a state
 *            nothing in either app could produce.
 *   callable Both entrants known and not started. Can be sent on now.
 *   waiting  An entrant is still TBD, because a feeder match has not been played.
 *            Not callable however free the courts are.
 */
export type DeskState = 'live' | 'callable' | 'waiting';

/** The columns of `tournament_matches` the desk reads. */
export interface DeskMatch {
  id: string;
  status: string;
  is_bye: boolean | null;
  phase?: string | null;
  round_number: number;
  match_number: number | null;
  bracket_position: number | null;
  court: string | null;
  participant_a_id: string | null;
  participant_b_id: string | null;
  pair_a_id: string | null;
  pair_b_id: string | null;
}

export interface DeskRow<M extends DeskMatch, S extends { entryId: string | null }> {
  match: M;
  a: S;
  b: S;
  state: DeskState;
}

/**
 * WHETHER THE COURTS TAB EXISTS, and so whether the live strip may point at it.
 * A completed event has no next match, and a court set on one is history: the
 * tab would be a working list with no work in it.
 */
export function hasCourtsTab(status: string): boolean {
  return eventHasDraw(status) && status !== 'completed';
}

/**
 * WHETHER A SCORE MAY BE ENTERED FROM THE DESK: only while the event is actually
 * being played, but the UNION of what the two half-tabs ask, not a copy of one
 * of them.
 *
 * BracketTab uses `eventIsPlaying || 'bracket_generated'` and RoundRobinTab adds
 * `'pool_generated'`, because a pool is drawn and played before a knockout
 * exists. The desk is deliberately given the WHOLE event so it works one queue
 * across both halves, so taking either tab's predicate alone would hide Enter
 * score here while the other tab still offered it, sending the desk back to the
 * screen it exists to replace, on exactly the format (pool_to_bracket) where
 * one queue matters most.
 */
export function deskEventPlaying(status: string): boolean {
  return eventIsPlaying(status) || status === 'bracket_generated' || status === 'pool_generated';
}

const phaseRank = (m: DeskMatch) => (m.phase === 'bracket' ? 1 : 0);
const ordinal = (m: DeskMatch) => m.match_number ?? m.bracket_position ?? 0;

/**
 * Every match still to be played, in the draw's own sequence.
 *
 * THE ORDER: THE DRAW'S OWN SEQUENCE, AND NOTHING ELSE. This list used to sort
 * uncourted matches first, on the theory that "which matches still need a court"
 * was the working question. In practice the owner's screenshot read "95 of 98
 * unplayed matches have no court yet", which is the sort admitting it does
 * nothing: on any real draw almost everything is uncourted, so the rule never
 * differentiates and its only effect is to hide the sequence the desk actually
 * works in. It was also quietly hostile: saving a court moved that row from the
 * top group to the bottom one, so the reward for typing "3" was watching the row
 * you were looking at jump off screen.
 *
 * So: phase, then round, then match number. Nothing about a match's STATE touches
 * the order, which means no row ever moves under the desk's hands: not when a
 * court is saved, not when someone is marked ready, not when a result lands
 * elsewhere and the whole list repaints. That is the property that makes the
 * Court Management tab safe to type into.
 *
 * PHASE OUTRANKS ROUND, and it has to (00107). The desk is given the whole event
 * rather than one half of it, because matches from both halves of a
 * pool_to_bracket event are called out of one queue, but `round_number` restarts
 * at 1 in the bracket, so ordering on it alone would interleave a pool round 1
 * with a quarter-final.
 *
 * MATCH NUMBER RATHER THAN bracket_position, because the number is what the desk
 * and the entrant both say out loud: the row prints "ROUND OF 128 · M4" and M4 is
 * the ordinal in that round. bracket_position is the layout's coordinate and can
 * differ. It falls back to bracket_position where match_number is null, which is
 * how a draw generated before 00080's renumbering still sorts sanely.
 */
export function deskRows<M extends DeskMatch, S extends { entryId: string | null }>(
  matches: M[],
  sideOf: (entryId: string | null) => S,
  isDoubles: boolean,
): Array<DeskRow<M, S>> {
  return matches
    .filter((m) => !isPlayedMatch(m) && !m.is_bye && m.status !== 'voided')
    .map((m) => {
      const a = sideOf(isDoubles ? m.pair_a_id : m.participant_a_id);
      const b = sideOf(isDoubles ? m.pair_b_id : m.participant_b_id);
      const bothKnown = !!a.entryId && !!b.entryId;
      const state: DeskState =
        m.status === 'live' ? 'live' : bothKnown ? 'callable' : 'waiting';
      return { match: m, a, b, state };
    })
    .sort((x, y) => {
      if (phaseRank(x.match) !== phaseRank(y.match)) return phaseRank(x.match) - phaseRank(y.match);
      if (x.match.round_number !== y.match.round_number) return x.match.round_number - y.match.round_number;
      return ordinal(x.match) - ordinal(y.match);
    });
}

/**
 * WHICH ONE IS "NEXT", AND WHY IT IS ONE AND NOT A SET.
 *
 * The earliest `callable` row in the order above. Three decisions in that:
 *
 * A `live` MATCH DOES NOT OUTRANK IT: it is excluded. "Next" means the one to
 * send on now, and a match already being played is not something you call; it is
 * something you wait for. Live matches carry their own ON COURT badge and are
 * counted separately, which is the fact the desk needs from them (how many
 * courts are busy).
 *
 * TBD IS NOT CALLABLE. A round-of-64 slot fed by unplayed round-of-128 matches
 * has no names in it, so however many courts are free it cannot be sent
 * anywhere. Those rows say what they are waiting for instead.
 *
 * ONE, THOUGH SEVERAL COURTS RUN AT ONCE, and the owner's "next one" is right
 * even though his need is plural. Several matches genuinely ARE callable: on a
 * fresh round of 128, all 64 of them. Badging 64 rows "callable now" would be
 * badging the whole list, which is not information. And the app CANNOT compute
 * "the next four", because nothing in this schema knows how many courts the club
 * has: `sessions` has no court column and nothing else counts them, which is
 * written down in two places already (admin dashboard/page.tsx, sessions/page.tsx).
 *
 * What makes one badge sufficient is the ordering above: the rows immediately
 * BELOW the one marked NEXT are, by construction, the ones after next. The desk
 * reads down. That is the whole reason ordering by the draw's own sequence and
 * marking a single next are the same feature rather than two.
 */
export function nextCallable<R extends { state: DeskState }>(rows: R[]): R | null {
  return rows.find((r) => r.state === 'callable') ?? null;
}

export function deskCounts(
  rows: Array<{ state: DeskState; match: { court: string | null } }>,
): { live: number; callable: number; waiting: number; uncourted: number } {
  const live = rows.filter((r) => r.state === 'live').length;
  const callable = rows.filter((r) => r.state === 'callable').length;
  return {
    live,
    callable,
    waiting: rows.length - live - callable,
    uncourted: rows.filter((r) => !courtLabel(r.match.court)).length,
  };
}

/**
 * What the shared ScoreEntryDialog needs, keyed by entry id: the display name,
 * the seed, and the entries the slot editor may place into an orphaned bracket
 * position. Withdrawn and disqualified entries are excluded from that last list
 * and refused again server-side: the client list is a convenience, not the rule.
 *
 * `nameOf` is passed in rather than imported so this file stays free of the
 * event page's component folder; every caller hands it `getName`, which is what
 * keeps a pair reading the same in the dialog, the bracket and the desk.
 */
export function buildEntryMaps<E extends { id: string; seed_number: number | null; status: string }>(
  entries: E[],
  nameOf: (entry: E) => string,
): {
  nameMap: Record<string, string>;
  seedMap: Record<string, number>;
  placeableEntries: Array<{ id: string; name: string }>;
} {
  const nameMap: Record<string, string> = {};
  const seedMap: Record<string, number> = {};
  for (const e of entries) {
    nameMap[e.id] = nameOf(e);
    if (e.seed_number) seedMap[e.id] = e.seed_number;
  }
  const placeableEntries = entries
    .filter((e) => e.status !== 'withdrawn' && e.status !== 'disqualified')
    .map((e) => ({ id: e.id, name: nameMap[e.id] ?? 'Unknown' }))
    .sort((a, b) => a.name.localeCompare(b.name));
  return { nameMap, seedMap, placeableEntries };
}
