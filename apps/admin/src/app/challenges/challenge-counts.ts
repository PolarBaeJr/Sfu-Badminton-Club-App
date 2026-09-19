import type { createAdminClient } from '@/lib/supabase-server';

/** The page's client. Service role, untyped by design. */
type Db = ReturnType<typeof createAdminClient>;

/**
 * The statuses a challenge is still LIVE in: somebody is expected to do
 * something about it.
 *
 * ONE LIST, because this page had two copies of it and the dashboard has a
 * third. `apps/player/src/lib/challenge-rules.ts` exports the same three under
 * `ACTIVE_CHALLENGE_STATUSES` with a test pinning them, and that is the
 * canonical list; it cannot be imported across the app boundary, so this is a
 * deliberate second home for it rather than a fourth copy. Moving it into
 * `packages/shared` would leave exactly one, and is the right follow-up.
 */
export const ACTIVE_STATUSES = ['proposed', 'partially_confirmed', 'accepted'] as const;

export type ChallengeCounts =
  /** A read failed. Distinct from zero, which is a claim about the club. */
  | { state: 'unavailable' }
  | { state: 'ok'; total: number; active: number };

/**
 * How many challenges there are, and how many are still live.
 *
 * *** COUNTED, NOT MEASURED OFF THE PAGE'S OWN ROWS. ***
 *
 * The table above is capped at 50 for the obvious reason, and both figures used
 * to be derived from that capped slice: "Total Challenges" printed
 * `challenges.length`, so a club with 400 of them read 50 forever, and "Active"
 * filtered the same 50 rows, so a genuinely open challenge outside the newest
 * 50 was missing from the tile as well as from the table.
 *
 * The console already knew how to do this correctly one screen away:
 * `app/dashboard/page.tsx` counts active challenges with a head count on the
 * same three statuses. Two cards in one console, the same word, different
 * answers. This makes them agree.
 *
 * `head: true` transfers no rows, and an exact count over `challenges` is a
 * trivial scan at any size this club will reach.
 *
 * NO SEASON SCOPE, and that is not an oversight: `challenges` has no
 * `season_id` column, so the page cannot be season-scoped and correctly does
 * not claim to be. Scoping it would mean inventing the scope, which is written
 * up as its own decision rather than smuggled in under a count fix.
 */
export async function loadChallengeCounts(db: Db): Promise<ChallengeCounts> {
  const [total, active] = await Promise.all([
    db.from('challenges').select('id', { count: 'exact', head: true }),
    db.from('challenges').select('id', { count: 'exact', head: true }).in('status', ACTIVE_STATUSES),
  ]);

  // *** A HEAD COUNT CANNOT REPORT ITS OWN FAILURE THROUGH `error`. ***
  //
  // Checking `error` alone is not enough here, and I only found that out by
  // pointing this function at a table that does not exist and watching the
  // page render 0. A HEAD request carries no body by definition, so PostgREST's
  // error document never arrives, and supabase-js resolves the failure as
  // `{ count: null, error: null, status: 204 }`. Measured against this club's
  // own stack, not assumed:
  //
  //   HEAD, missing table  ->  { count: null, error: null,     status: 204 }
  //   GET,  missing table  ->  { count: null, error: PGRST205, status: 404 }
  //   HEAD, real table     ->  { count: 126,  error: null,     status: 200 }
  //
  // So the only honest signal a head count gives is the count itself. A null
  // count is a read that did not answer; `?? 0` would turn it into a confident
  // claim that the club has no challenges, which is indistinguishable from the
  // truth once it has been rendered as the digit 0.
  if (total.error || active.error) return { state: 'unavailable' };
  if (total.count === null || active.count === null) return { state: 'unavailable' };

  return { state: 'ok', total: total.count, active: active.count };
}
