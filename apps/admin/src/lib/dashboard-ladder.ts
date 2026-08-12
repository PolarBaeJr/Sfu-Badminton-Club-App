import type { SupabaseClient } from '@supabase/supabase-js';
import { unwrap } from '@badminton/shared';

/**
 * THE SHAPE OF THE CLUB'S LADDER, FOR THE DASHBOARD.
 *
 * Gated on `players.read` and on nothing else. That capability is the one the
 * roster fetch answers to and it is what /players already gates its embedded
 * `ratings(...)` select on, so this reads exactly the data that page reads,
 * under exactly its permission.
 *
 * NOT `ratings.page`, which is the obvious-looking wrong answer. That key gates
 * /ratings, which is the platform's rating KNOBS — k-factors, provisional
 * thresholds — and permissions.ts records it as admin-only in both halves
 * because the club owner wants execs kept off the rating rules entirely. Gating
 * a distribution of members' ratings on a settings key would put roster data
 * behind the wrong door in both directions: admin-only for a figure a trainer
 * may already read one row at a time, and a settings capability standing in for
 * a roster one.
 *
 * `players.read` is in TRAINER_BASELINE, so this is the first chart on the
 * dashboard that every console user sees.
 */

export interface LadderSpread {
  /** Non-provisional singles ratings. The chart bins these. */
  singles: number[];
  doubles: number[];
  /** How many members are still settling, per discipline — said, not drawn. */
  singlesProvisional: number;
  doublesProvisional: number;
}

interface RatingRow {
  singles_elo: number | null;
  doubles_elo: number | null;
  singles_provisional: boolean | null;
  doubles_provisional: boolean | null;
}

/**
 * ONE QUERY, FOUR COLUMNS, AND AN INNER JOIN THAT IS A FILTER.
 *
 * COST: one round trip returning one row per rated member — about a hundred
 * today. It is bounded by the size of the club and by nothing else, which is
 * the honest description: a distribution has no top-N to take, because dropping
 * the tail is precisely the distortion the chart exists to avoid. If this club
 * ever passes a few thousand members the answer is a histogram computed in the
 * database, not a limit here.
 *
 * `players!inner` makes the join a FILTER rather than a nullable embed: a
 * suspended member or a pending signup still has a ratings row, and counting
 * them in "the shape of the field" would draw a ladder the club does not play
 * on. PostgREST needs SOMETHING selected from an embed to join through it, so
 * it selects `id` and nothing else — the narrowest column there is, and one
 * `players.read` owns anyway. Those ids stay on the server: this function
 * returns arrays of numbers and two counts, so nothing identifying a member
 * reaches the RSC payload.
 *
 * PROVISIONAL RATINGS ARE EXCLUDED FROM THE BINS AND COUNTED INSTEAD. A rating
 * below the provisional threshold is still settling and moves further per
 * match; binning it puts a member in a band they will leave next week. The
 * count is reported so the panel can say how many are missing rather than
 * quietly showing a smaller club.
 *
 * The stored `*_provisional` booleans are the test, NOT the PROVISIONAL_THRESHOLD
 * constant. That threshold is also a database setting (00041), so the TypeScript
 * mirror of it can disagree with the value the rating engine actually used; the
 * booleans are written by the engine and cannot.
 *
 * RUN AGAINST STAGING BEFORE SHIPPING, because nothing else could check it: the
 * admin client carries no generated Database type, so tsc proves nothing about
 * this chain, and an embedded-resource filter that PostgREST rejects would
 * throw through unwrap() before the first byte of markup — on the dashboard of
 * every console user, since players.read is in TRAINER_BASELINE. It returns 98
 * rows there: 92 settled singles ratings over 402–1400 and 6 provisional, 86
 * settled doubles and 12 provisional, which is exactly what the equivalent SQL
 * returns.
 */
export async function getLadderSpread(supabase: SupabaseClient): Promise<LadderSpread> {
  const result = await supabase
    .from('ratings')
    .select(
      'singles_elo, doubles_elo, singles_provisional, doubles_provisional, players!inner(id)',
    )
    .neq('players.status', 'pending_approval')
    .eq('players.active_flag', true);

  // unwrap, not `?? []`. An errored query read as an empty ladder would draw
  // "no member has a rating yet" over a club of a hundred rated players — a
  // plausible-looking picture of a false fact, which is the failure this
  // codebase refuses everywhere it counts anything.
  const rows = unwrap(result as { data: RatingRow[] | null; error: { message: string } | null });

  const spread: LadderSpread = {
    singles: [],
    doubles: [],
    singlesProvisional: 0,
    doublesProvisional: 0,
  };
  for (const row of rows) {
    if (row.singles_provisional) spread.singlesProvisional += 1;
    else if (row.singles_elo !== null) spread.singles.push(row.singles_elo);
    if (row.doubles_provisional) spread.doublesProvisional += 1;
    else if (row.doubles_elo !== null) spread.doubles.push(row.doubles_elo);
  }
  return spread;
}
