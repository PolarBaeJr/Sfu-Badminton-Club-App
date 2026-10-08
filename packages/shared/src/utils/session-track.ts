// Which session TRACKS a member's schedule should show them.
//
// TWO ENUMS THAT SHARE TWO WORDS AND ARE NOT THE SAME DOMAIN. This module
// exists because six call sites treated them as one:
//
//   session_group  (sessions.track)   competitive | recreational | all
//   player_status  (players.status)   competitive | recreational | pending_approval | suspended
//
// Every one of them wrote `.in('track', [player.status, 'all'])`, which is
// correct for exactly two of the four statuses. For the other two Postgres
// rejects the whole predicate at PLAN time:
//
//   ERROR: invalid input value for enum session_group: "pending_approval"  (22P02)
//
// PostgREST answers 400, supabase-js RESOLVES rather than rejects, and the
// `?? []` at every call site turned that into an empty list — so a member
// waiting to be approved was shown "No sessions yet" while twelve open sessions
// existed, on /sessions, on /feed and in their ICS subscription. It went
// unreported for months precisely because nothing ever said "400".
//
// SO THE FIX IS A MAPPING, NOT A CAST AND NOT A FILTER. Casting `player.status`
// to a track asserts the two domains are one, which is the original mistake with
// a type assertion on top. Filtering the array down to "values session_group
// happens to have" would silently mean "pending members see only club-wide
// nights", a product decision arrived at by accident. This asks the actual
// question — what is this member's track? — and answers "they have not got one".
//
// WHAT AN UNTRACKED MEMBER SEES: EVERYTHING. `track` is a RELEVANCE filter and
// nothing else. It is not a security boundary: `sessions_select ON sessions FOR
// SELECT TO authenticated USING (TRUE)` (00005_rls.sql:104) lets any signed-in
// member read every session row, so narrowing here withholds nothing they could
// not fetch directly. /sessions says the same thing in its own words — "the
// schedule stays visible for everyone, knowing when the club plays is not a
// privilege" — and withholds the CONTROLS through getAccountStanding instead.
//
// A member with no track therefore has no relevance signal to filter on, and
// the honest answer to "which nights are for me?" is "all of them, until
// somebody tells you". That is also the only answer that fixes the reported
// symptom: a frosh-week signup sits at `pending_approval` until an exec presses
// Approve, and returning just ['all'] would still show them an empty schedule
// on any night an exec tagged `competitive` or `recreational`.
//
// `suspended` gets the same answer for the same reason rather than a second
// branch. A suspension overwrites the track column, so a suspended member has no
// track either; they can already read every session row; and every control on
// the page is withheld by standing. Narrowing them to ['all'] would be a
// cosmetic branch that buys no safety and adds a second rule to keep true.
//
// AN ALLOWLIST, NOT A DENYLIST, AND THAT IS THE PART THAT STOPS THIS RECURRING.
// Naming `pending_approval` and `suspended` as the exceptions would break the
// day a fifth `player_status` value is added — the new value would fall through
// to the enum-rejecting branch and reintroduce the outage. Recognising the two
// TRACK values and defaulting everything else means an unknown status is
// harmless by construction, which is what the test asserts over arbitrary
// strings rather than over today's four.

/**
 * The `session_group` enum, verbatim (00001_schema.sql:248). The vocabulary a
 * `track` filter may ever contain — anything else is a 22P02 at plan time.
 */
export const SESSION_TRACKS = ['competitive', 'recreational', 'all'] as const;

export type SessionTrack = (typeof SESSION_TRACKS)[number];

/** True for the two `player_status` values that are also `session_group` values. */
function isTrackStatus(status: string): status is 'competitive' | 'recreational' {
  return status === 'competitive' || status === 'recreational';
}

/**
 * The tracks a member of this status should be shown, as a `session_group`
 * allowlist safe to hand straight to `.in('track', …)`.
 *
 * @param status `players.status`, or anything at all — a null, a column that
 *   was not selected, or a value from a future migration. Total by design: the
 *   answer is always a subset of SESSION_TRACKS, so no input can produce a
 *   predicate Postgres will refuse.
 */
export function visibleTracksFor(status: string | null | undefined): SessionTrack[] {
  if (typeof status === 'string' && isTrackStatus(status)) return [status, 'all'];
  // No track assigned — pending, suspended, or a status this build does not
  // know. Show the whole schedule rather than a filtered-down slice of it.
  return [...SESSION_TRACKS];
}

/**
 * What a viewer who is NOT a signed-in member may be shown: club-wide nights only.
 *
 * THIS IS NOT A CONTRADICTION OF THE "EVERYTHING" DEFAULT ABOVE, it is the case
 * that default never covered.
 *
 * visibleTracksFor's reasoning for showing an untracked member the whole
 * schedule rests on one specific fact, quoted from it: `sessions_select ON
 * sessions FOR SELECT TO authenticated USING (TRUE)`. Narrowing an untracked
 * MEMBER withholds nothing, because they can read every session row directly
 * whenever they like. The filter is therefore about relevance and nothing else,
 * and the honest answer to "which nights are for me?" is "all of them".
 *
 * That argument needs the viewer to be `authenticated`. The Discord bot's
 * audience is not: anybody who joins the server can run /sessions without ever
 * having an app account, and there is no RLS policy granting them anything.
 * For that viewer the same filter IS the only thing standing between them and
 * the schedule, so "narrowing withholds nothing" is simply false, and the
 * frosh-week argument does not apply either — a person with no account is not
 * waiting on an exec to press Approve.
 *
 * So an unlinked viewer gets the club-wide nights, which is what a prospective
 * member is actually looking for, and the bot points them at /link for the rest.
 * A LINKED member goes through visibleTracksFor exactly as the website does —
 * including the untracked-sees-everything default, which stays untouched.
 */
export const PUBLIC_TRACKS: SessionTrack[] = ['all'];
