import type { createAdminClient } from '@/lib/supabase-server';
import type { LadderShape } from './ratings-aside';

/** The page's client. Service role, untyped by design. */
type Db = ReturnType<typeof createAdminClient>;

/**
 * How many members these settings apply to, and how many of them still move on
 * the provisional K-factors.
 *
 * WHO IS ON THE LADDER IS THE DATABASE'S ANSWER, NOT THIS PAGE'S.
 *
 * This used to count `ratings` outright, which is every rating row that has
 * ever existed. A rating row OUTLIVES eligibility on purpose: a member who goes
 * inactive, opts out with hide_from_leaderboard, or is awaiting approval keeps
 * their history rather than having it destroyed. So the card said 39 members on
 * the ladder while the ladder itself had 31, measured on production
 * 2026-09-19: 5 inactive, 2 opted out, 2 pending, one person in two of those at
 * once.
 *
 * The fix is NOT to restate the visibility rule here. get_leaderboard() already
 * ends with `active_flag = TRUE AND hide_from_leaderboard = FALSE AND status
 * NOT IN ('pending_approval','suspended')`, and api/discord/leaderboard spells
 * out why nobody re-filters it: a second copy of the club's visibility rules is
 * a copy that drifts. Note that the fourth clause is one this page would
 * plausibly have forgotten, since the club currently has zero suspended
 * members and omitting it would have measured as correct.
 *
 * So eligibility comes from the function and the ids it returns drive both
 * other counts. That also keeps all three figures on ONE population, which
 * KFactorPanel depends on: it draws the established bar as
 * `total - singlesProvisional`, so a total and a provisional count taken over
 * different people would not merely be wrong, they would disagree.
 *
 * The provisional condition stays here because it is not a visibility rule. It
 * is the STORED FLAG OR the match count, because that is what decides the
 * K-factor on both sides of the engine: apply_match_result (00041) branches on
 * `singles_provisional OR singles_matches_played < v_threshold`, and
 * getKFactor() in the TS engine says the same thing. Counting the flag alone
 * would print a figure that does not move when the field above it does: the
 * threshold clears the flag only on the match that crosses it, so raising the
 * threshold makes established players provisional again through the second
 * clause and through nothing else.
 *
 * A read that fails returns 'unavailable' rather than zero. supabase-js
 * RESOLVES a PostgREST 400/403 instead of throwing, so `count ?? 0` would paint
 * a confident "0 members on the ladder" over a broken grant, which is a worse
 * lie than the 39 this replaces.
 */
export async function loadLadder(db: Db, allowed: boolean, threshold: number): Promise<LadderShape> {
  if (!allowed) return { state: 'withheld' };

  // Untyped client (supabase-server.ts: typed clients are deliberately off), so
  // the row shape is asserted. Only `id` is read; the other 15 columns are the
  // function's, not this page's business.
  const eligible = await db.rpc('get_leaderboard');
  if (eligible.error) return { state: 'unavailable' };
  const ids = ((eligible.data ?? []) as Array<{ id: string }>).map((row) => row.id);

  // An empty ladder is a real answer, and `.in()` with no ids is not: PostgREST
  // would take `in.()` as a filter matching nothing, which happens to be right
  // here, but only by accident. Say it outright instead.
  if (ids.length === 0) {
    return { state: 'ok', total: 0, singlesProvisional: 0, doublesProvisional: 0 };
  }

  // Sending the ids is fine at club scale and is a deliberate ceiling, not an
  // oversight: this is a URL, and a few hundred uuids in one is a request some
  // proxy will refuse. If the club outgrows that, the count belongs in a SQL
  // function beside get_leaderboard(), not in a longer query string.
  const provisional = (discipline: 'singles' | 'doubles') =>
    db
      .from('ratings')
      .select('id', { count: 'exact', head: true })
      .in('player_id', ids)
      .or(`${discipline}_provisional.eq.true,${discipline}_matches_played.lt.${threshold}`);

  const [singles, doubles] = await Promise.all([provisional('singles'), provisional('doubles')]);
  // *** A HEAD COUNT CANNOT REPORT ITS OWN FAILURE THROUGH `error`. ***
  //
  // Checking `error` alone was this function's original guard and it was not
  // enough. A HEAD request carries no body by definition, so PostgREST's error
  // document never arrives and supabase-js resolves the failure as
  // `{ count: null, error: null, status: 204 }`. Measured against this club's
  // own stack: a head count on a missing table returns exactly that, while the
  // same read issued as a GET returns PGRST205. So the count itself is the only
  // honest signal, and `?? 0` would have reported every member as established.
  if (singles.error || doubles.error) return { state: 'unavailable' };
  if (singles.count === null || doubles.count === null) return { state: 'unavailable' };

  return {
    state: 'ok',
    total: ids.length,
    singlesProvisional: singles.count,
    doublesProvisional: doubles.count,
  };
}
