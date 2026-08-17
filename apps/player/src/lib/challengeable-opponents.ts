// The opponent list behind /challenges/new, read SERVER-SIDE and for one
// reason: `is_banned`.
//
// The picker used to build its own list in the browser, filtering active_flag
// and status and nothing else, so A BANNED MEMBER WAS OFFERED AS A
// CHALLENGEABLE OPPONENT. It could not be fixed where it broke: 00032 revoked
// blanket SELECT on `players` and the column grants for `authenticated` cover
// active_flag, status, id, full_name, handle and avatar_url but NOT is_banned
// (verified against both databases, 2026-08-17). A browser-side
// `.eq('is_banned', false)` would not narrow the list — it would 403 the whole
// request, which PostgREST hands back as an empty array, and the picker would
// silently offer nobody at all.
//
// So the read moves to the server and runs through the service-role client,
// which bypasses RLS and the column grants. The flag is used as a FILTER and
// never returned: the shape below is exactly what the browser could already
// see.
//
// SEVERITY, HONESTLY. This is a UX bug, not a hole. validate_challenge_creation
// (00048/00053) already refuses a banned opponent with "Opponent cannot accept
// challenges", and createChallenge calls it, so the challenge was never going
// to be created. What was wrong is that the form offered a name it would then
// reject at submit — the same failure the ?opponent= staleness handling in the
// client exists to avoid.
import { createServiceRoleClient } from './supabase-server';

// NO avatar_url, deliberately. The browser query it replaces SELECTED the
// column and then never mapped it into its options, so PlayerPicker has always
// been handed `avatarUrl: null` on this screen. Returning it here would start
// rendering avatars in the picker — a visual change nobody asked for, on a
// screen with unrelated work in flight. Same shape in, same shape out.
export interface ChallengeableOpponent {
  id: string;
  full_name: string;
  handle: string | null;
  singles_elo: number;
  doubles_elo: number;
}

// Minimal structural type so a test can pass a stub — the Supabase clients in
// this repo are constructed untyped (see the note in supabase-server.ts), so
// there is no Database generic to borrow. Same device as challenge-settings.ts.
type PlayerReader = { from: (table: string) => any };

/**
 * Every member the viewer may be offered as an opponent.
 *
 * `excludePlayerId` is the viewer's own players.id. It is optional because the
 * caller reads it from getCurrentPlayer(), which can return null; when it is
 * missing the viewer is simply not filtered out, which the client's own
 * self-check and validate_challenge_creation's "Cannot challenge yourself" both
 * still catch.
 *
 * A failed read returns [] rather than throwing. The page is still useful — the
 * format and date fields work — and an empty picker is the same thing the
 * browser-side read produced on failure, so nothing regresses.
 */
export async function listChallengeableOpponents(
  excludePlayerId?: string | null,
  client?: PlayerReader,
): Promise<ChallengeableOpponent[]> {
  const supabase = client ?? createServiceRoleClient();

  // EVERY filter the browser applied is re-applied here, because the
  // service-role client bypasses RLS and would otherwise widen the list rather
  // than narrow it. is_banned is the one being added.
  let query = supabase
    .from('players')
    .select('id, full_name, handle, ratings(singles_elo, doubles_elo)')
    .eq('active_flag', true)
    .eq('is_banned', false)
    .not('status', 'in', '("pending_approval","suspended")');

  if (excludePlayerId) query = query.neq('id', excludePlayerId);

  const { data, error } = await query;
  if (error) return [];

  return (data ?? []).map((p: any) => {
    const r = Array.isArray(p.ratings) ? p.ratings[0] : p.ratings;
    return {
      id: p.id,
      full_name: p.full_name,
      handle: p.handle ?? null,
      // 400 is the seed rating (create_player_with_rating, 00023), so a member
      // with no ratings row previews as a brand-new player rather than as 0.
      singles_elo: r?.singles_elo ?? 400,
      doubles_elo: r?.doubles_elo ?? 400,
    };
  });
}
