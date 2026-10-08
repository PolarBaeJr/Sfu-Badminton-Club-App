// The one list of statuses that mean a challenge is still LIVE.
//
// This started in apps/player/src/lib/challenge-rules.ts and moved here once
// there were three copies of it: the player's quota meter, the admin console's
// /challenges counts, and the console dashboard's "active challenges" tile,
// which had the three strings inlined into its query. Each copy was correct on
// the day it was written, which is exactly the problem: the club's answer to
// "how many challenges are open right now" was being computed three times from
// three literals that nothing forced to agree.
//
// Pure: no Supabase, no React, no clock. It is a list of strings that callers
// hand to their own query or predicate.

/**
 * The statuses validate_challenge_creation counts against
 * challenge_rules.max_active_challenges.
 *
 * Copied from the SQL rather than reasoned out, and shared rather than repeated
 * so that the query which counts them and the meter which draws them cannot
 * come to disagree. A meter reading "2 of 3" on the screen that just refused
 * you is worse than no meter at all, and a console tile that counts a different
 * set than the gate does is the same bug wearing an admin's hat.
 *
 * Note this is a status list and not a clock: the sweep that retires a lapsed
 * challenge runs hourly, so one still sitting at 'proposed' past its deadline
 * genuinely does hold a slot until the job catches it. The screens say so
 * because the database means it.
 */
export const ACTIVE_CHALLENGE_STATUSES = ['proposed', 'partially_confirmed', 'accepted'] as const;
