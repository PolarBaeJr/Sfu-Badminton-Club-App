// Section-level access control for the admin app. The real security boundary is
// the server action (service-role bypasses RLS); this map is the single source of
// truth for which access level a section requires, shared by middleware and nav.
//
// THREE ORDERED LEVELS — admin > exec > trainer. Each one's powers are a strict
// subset of the level above, so a section is described by the MINIMUM level that
// may enter it and everything higher is admitted automatically. Anything not
// listed defaults to admin-only.
//
//  - admin    role = 'admin'. Everything.
//  - exec     is_exec. Runs the club: roster, matches, sessions, tournaments,
//             seasons, announcements.
//  - trainer  is_trainer. Coaches the varsity squad. Reads the roster so they
//             can find a player, and writes varsity notes. Nothing else — see
//             ./player-field-access.ts, where their writable field set is EMPTY.
//
// SECOND AXIS — exec portfolios. The levels are a ladder; the club is not. An
// exec may hold one of four VP portfolios (finance, tournaments, internal,
// external), and a portfolio NARROWS that exec and never widens anyone:
// players.portfolio IS NULL is exactly the access an exec has always had, which
// is why assigning one is an explicit, reversible act by an admin and why
// nothing changed for anyone when the column shipped. Admins are superusers and
// are not narrowed; trainers hold no portfolio.
//
// This map is still only middleware and nav. The REAL boundary for the same
// split is getAuthenticatedExecOrAdmin(portfolio) in ./supabase-server.ts, which
// every server action names its portfolio to — narrowing this file alone would
// be theatre, because the actions run on a service-role client that bypasses
// RLS and can be called directly.
//
// The LEVELS themselves — the ordering, and how a player row resolves to one —
// now live in @badminton/shared so the members' app can ask the same question
// without hand-rolling its own copy (which it did, twice, and they disagreed
// about trainers). What stays here is the admin-only half: which PATH needs
// which level.
// Deep import, NOT the '@badminton/shared' barrel. This module is pulled into
// the EDGE middleware through canAccess(), and the barrel re-exports the mail
// sender, which drags `resend` and a Supabase client in with it: importing it
// here took the built middleware from 321 KB to 843 KB, on every request, for
// three pure functions. Same reason push/send is imported by path elsewhere.
import {
  atLeast,
  portfolioPermits,
  type AccessLevel,
  type Portfolio,
} from '@badminton/shared/src/utils/access-level';

// Re-exported so every existing `from '@/lib/permissions'` import keeps working
// and there is still ONE place in the admin app to look for these.
export {
  accessLevelFor,
  atLeast,
  consoleAccessLevelFor,
  hasConsoleAccess,
  isInGoodStanding,
  portfolioOf,
  portfolioPermits,
  PORTFOLIOS,
  PORTFOLIO_LABELS,
} from '@badminton/shared/src/utils/access-level';
export type { AccessLevel, Portfolio } from '@badminton/shared/src/utils/access-level';

const SECTION_ACCESS: { [pathPrefix: string]: AccessLevel } = {
  // The console root, which only redirects to /dashboard (app/page.tsx). It has
  // to be listed: unmatched paths default to admin, and middleware runs BEFORE
  // the redirect, so without this line every non-admin opening /admin — which is
  // where the player app's "Exec Panel" link points — was bounced to
  // /unauthorized. Matches the root and nothing else: the prefix test is
  // `pathname === prefix || pathname.startsWith(prefix + '/')`, and no real path
  // begins with '//'.
  '/': 'trainer',
  // Where sign-in lands. Trainers need to get through the front door; the
  // dashboard gates each tile with canAccess() so they only see their own.
  '/dashboard': 'trainer',
  '/announcements': 'exec',
  '/matches': 'exec',
  '/tournaments': 'exec',
  '/sessions': 'exec',
  '/seasons': 'exec',
  // Finances. Exec-level ONLY so an exec can reach the Expenses tab: the club
  // owner asked for "execs can add expenses", not for the finance page. Club
  // fees, other income, reinstatements and the net-position strip stay
  // admin-only, and /fees/page.tsx enforces that by skipping their FETCHES for
  // a non-admin rather than hiding the rendered output — a hidden card whose
  // query still ran ships the figures into the RSC payload for anyone with
  // devtools. Same reasoning, and the same shape, as dashboard/page.tsx.
  //
  // This line is therefore NOT the whole story for this section, unlike every
  // other entry in this map. Anything that asks "may this person see club
  // money?" must ask for 'admin' explicitly and must NOT reuse
  // canAccess(level, '/fees') — the dashboard finance snapshot is the one place
  // that did, and flipping this line is precisely what would have leaked it.
  '/fees': 'exec',
  '/audit': 'admin',
  // Execs read the documents and may require a re-signature; only admins edit
  // the text. That split is enforced in the page and in the server actions —
  // this line only decides who may open the section.
  '/legal': 'exec',
  // Platform configuration, split out of /settings. Admin-only in BOTH halves,
  // unlike Legal: the club owner wants execs kept off the rating and account
  // rules entirely, not shown a read-only copy. Each page re-checks with
  // getAuthenticatedAdmin() and updatePlatformSettings() gates again — this line
  // only decides who may open the section.
  '/ratings': 'admin',
  '/accounts': 'admin',
  '/settings': 'trainer', // everyone with console access enrolls their own passkeys
  '/api/passkey': 'trainer', // passkey enrollment/verification endpoints
  // Execs run the roster: approve, edit, ban/unban, varsity notes. Granting
  // exec/admin is NOT part of that — the per-field split lives in
  // ./player-field-access.ts, and destructive actions (remove, merge) keep
  // getAdminPlayer() in the server action.
  //
  // Trainers get in one rung lower, and ONLY to read: this is where the varsity
  // notes live, and finding the player you are writing about means seeing the
  // list. Every mutating action under /players gates on getExecOrAdmin() or
  // getAdminPlayer(), neither of which admits a trainer, and the pages hide the
  // controls so nothing on screen is guaranteed to reject them.
  '/players': 'trainer',
  '/disputes': 'admin',
  '/walkovers': 'admin',
  '/challenges': 'admin',
  // The permission editor: who holds which exec portfolio. Admin-only, and it
  // must STAY admin-only — an exec who could reach it could widen their own
  // portfolio, which is the whole point of the column.
  '/permissions': 'admin',
};

// WHICH PORTFOLIO OWNS WHICH SECTION. The second axis, and it only ever
// NARROWS: a section is reachable when the caller clears BOTH the level above
// and the portfolio here.
//
// Read with SECTION_ACCESS, never instead of it. Nothing in this map grants
// anything — /fees is 'finance' here AND 'exec' above, so the finance VP
// reaches the same Expenses tab any exec reaches and no more; the admin-only
// halves of that page are still admin-only.
//
// That answers design open question 3 — "does the finance portfolio change the
// exec/admin split inside /fees?" It does not, and it must not: the split
// exists because club fees, other income, reinstatements and the net position
// are the club's books, and "VP of Finance" is an elected student, not a second
// admin. The portfolio decides WHICH execs reach the section; the page decides
// what any non-admin sees inside it. Two independent questions, kept that way.
//
// The cost, stated plainly because somebody will meet it: an exec assigned
// 'tournaments' can no longer file the expense for the shuttles they bought,
// because filing an expense is /fees. Recording money is one job or it is
// nobody's. An admin who wants the old behaviour for a particular person leaves
// that person's portfolio at none — which is the whole point of NULL.
const SECTION_PORTFOLIO: { [pathPrefix: string]: Portfolio } = {
  '/fees': 'finance',
  '/tournaments': 'tournaments',
  '/matches': 'tournaments',
  '/sessions': 'tournaments',
  '/players': 'internal',
  '/seasons': 'internal',
  '/legal': 'external',
  '/announcements': 'external',
};

// What every console user keeps regardless of portfolio. These are not powers:
// the front door, the landing page, and enrolling your own passkeys. Without
// them a portfolio would lock its holder out of the console entirely.
//
// Matched with the same segment-prefix rule as SECTION_ACCESS, so '/' is the
// root and nothing else.
const BASELINE_SECTIONS = ['/', '/dashboard', '/settings', '/api/passkey'];

// Admin-only sub-routes that sit *under* an exec-allowed section and would
// otherwise inherit its access via prefix match. Tournament entry fees live at
// /tournaments/<id>/fees — execs run tournaments, but all money handling is
// admin-only. Checked before prefix matching.
const ADMIN_ONLY_PATTERNS: RegExp[] = [
  /^\/tournaments\/[^/]+\/fees(\/|$)/,
];

// Does this path sit inside this section? Segment-aware, so '/players' never
// matches '/playersecret'. The one matching rule, shared by both maps.
function isUnder(pathname: string, prefix: string): boolean {
  return pathname === prefix || pathname.startsWith(prefix + '/');
}

// Longest-prefix lookup in a section map. Returns undefined when nothing
// matches; each caller decides what an unmatched path means, and both of them
// fail closed.
function longestPrefixMatch<T>(map: { [prefix: string]: T }, pathname: string): T | undefined {
  let best = '';
  for (const prefix of Object.keys(map)) {
    if (isUnder(pathname, prefix) && prefix.length > best.length) best = prefix;
  }
  return best ? map[best] : undefined;
}

// Resolve a pathname to the access level its section requires (longest-prefix
// match). Unmatched paths default to admin-only.
function requiredLevel(pathname: string): AccessLevel {
  if (ADMIN_ONLY_PATTERNS.some((re) => re.test(pathname))) return 'admin';
  return longestPrefixMatch(SECTION_ACCESS, pathname) ?? 'admin';
}

// The portfolio half of the decision, for someone who has ALREADY cleared the
// level. Written as an ALLOW-LIST — baseline, or a section this portfolio owns —
// so a new section added to SECTION_ACCESS without a SECTION_PORTFOLIO entry is
// refused to a portfolio'd exec, exactly as an unlisted path is refused to
// everyone below admin. A deny-list would have failed open on every future
// section, silently.
//
// ADMIN_ONLY_PATTERNS is not consulted here: /tournaments/<id>/fees is already
// admin-only by level, and a portfolio never widens anyone, so the finance
// portfolio does not reach it (open question 4). Tournament money stays with
// admins, as it did before portfolios existed.
function portfolioAdmits(
  level: AccessLevel | null,
  portfolio: Portfolio | null,
  pathname: string,
): boolean {
  if (level !== 'exec' || portfolio === null) return true;
  if (BASELINE_SECTIONS.some((prefix) => isUnder(pathname, prefix))) return true;
  const owner = longestPrefixMatch(SECTION_PORTFOLIO, pathname);
  return owner !== undefined && portfolioPermits(level, portfolio, owner);
}

/**
 * May this person open this section?
 *
 * BOTH arguments are required, and `portfolio` deliberately so: an optional one
 * would default to "no portfolio" at every call site that forgot it — which is
 * full exec access, i.e. it would fail OPEN in the direction this whole feature
 * exists to close.
 *
 * A portfolio narrows and never widens, so `portfolio === null` is byte-for-byte
 * the behaviour that shipped before portfolios existed.
 *
 * Two consequences of narrowing, both worth stating out loud because they only
 * bite AFTER an admin has explicitly assigned a portfolio (and are undone by
 * setting it back to none):
 *   1. A portfolio'd exec loses /players unless their portfolio is 'internal' —
 *      including the read a varsity trainer keeps. Reading the roster is PII,
 *      not a baseline convenience, so it is a power like any other.
 *   2. An exec who is ALSO a trainer resolves to 'exec' (accessLevelFor takes
 *      the highest level held), so a portfolio narrows them below what the
 *      trainer marker alone would have given. Same reasoning: the restriction
 *      follows the level someone resolves to, never a flag in isolation.
 */
export function canAccess(
  level: AccessLevel | null,
  portfolio: Portfolio | null,
  pathname: string,
): boolean {
  if (level === null) return false;
  if (!atLeast(level, requiredLevel(pathname))) return false;
  return portfolioAdmits(level, portfolio, pathname);
}
