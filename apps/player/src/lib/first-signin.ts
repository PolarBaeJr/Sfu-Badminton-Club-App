// Giving a signing-in member their `players` row.
//
// Until 00132 the row was written at the END of onboarding, so between pressing
// "sign up" and finishing setup a person existed in auth and not in the app —
// invisible to the roster, to Needs Attention, to the merge picker and to every
// chart, because all of those read `players`. Production carries 17 such
// accounts, one of them a real member who signed up, signed in four minutes
// later and never came back.
//
// ALL THE JUDGEMENT IS IN SQL, ON PURPOSE — the same division as
// applySkillTier/apply_skill_tier_seed. ensure_player_for_user() decides
// claim-or-create, applies the roster claim's privilege rule and writes the
// audit row, because that decision has to be race-safe: two requests for the
// same person arriving together must produce ONE row, and two people must never
// claim the same roster row. Those are single-statement guarantees and only the
// database can offer them. This file is the call.
//
// CALLED FROM THREE PLACES, and the third is not redundant:
//   /auth/callback      OAuth and magic-link sign-in
//   /auth/post-login    OTP code and passkey sign-in
//   /onboarding layout  everyone else — a member holding a LIVE SESSION and no
//                       row passes through neither auth route again, and the
//                       middleware sends them straight here. That is the path
//                       the 17 existing accounts take when they come back, and
//                       the path anyone mid-flow at deploy time takes.
// The function is idempotent, so three call sites is the safety, not the cost:
// after the first one it is a single indexed lookup and a return.

import * as Sentry from '@sentry/nextjs';
import { createServiceRoleClient } from './supabase-server';

/**
 * Make sure a signed-in auth user has a `players` row, claiming an unclaimed
 * roster row an exec pre-added for them if one matches their address.
 *
 * NEVER THROWS. A sign-in must not fail because this did — the member would be
 * left with a session and an error page, which is worse than the state this
 * exists to fix. Every failure is reported and swallowed, and the app behaves
 * exactly as it did before 00132: no row, middleware sends them to /onboarding,
 * completeOnboarding creates one. That includes the deliberate refusals
 * (ambiguous roster match), which return null rather than raising precisely so
 * that the sentence explaining them can be shown on a screen that has one.
 *
 * @returns the players.id, or null when nothing was created or found.
 */
export async function ensurePlayerRowForUser(userId: string): Promise<string | null> {
  if (!userId) return null;
  try {
    // Service role: the row does not exist yet, so there is nothing RLS could
    // scope to the caller, and the claim has to see roster rows that are not
    // linked to anybody. Same reasoning as the claim path this replaces
    // (profile.ts) and as reactivateLapsedMemberByUserId, which runs beside it.
    const { data, error } = await createServiceRoleClient().rpc('ensure_player_for_user', {
      p_user_id: userId,
    });
    if (error) throw new Error(error.message);
    return (data as string | null) ?? null;
  } catch (error) {
    Sentry.captureException(error, { extra: { action: 'ensurePlayerRowForUser', userId } });
    return null;
  }
}
