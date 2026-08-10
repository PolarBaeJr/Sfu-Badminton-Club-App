// Section-level access control for the admin app. The real security boundary is
// the server action (service-role bypasses RLS); this map is the single source of
// truth for which capability a section requires, shared by middleware and nav.
//
// WHAT A PERSON MAY DO IS A SET OF CAPABILITIES, not a rung on a ladder. The
// three levels — admin > exec > trainer — still exist and still decide who
// reaches the console at all, but they no longer answer "may this person do
// X": that is permits(), and it is plain membership in the set the person
// resolves to. See @badminton/shared's access-level.ts for the vocabulary and
// the two baselines.
//
//  - admin    role = 'admin'. Superuser BY LEVEL: permits() short-circuits
//             before any set is consulted, so a capability added next year is
//             automatically theirs.
//  - exec     is_exec. EXEC_BASELINE — the roster, matches, sessions,
//             tournaments, seasons, announcements, and filing an expense.
//  - trainer  is_trainer. TRAINER_BASELINE — reading the roster and writing
//             varsity notes, and that is the whole level. See
//             ./player-field-access.ts, where their writable field set is EMPTY.
//
// This file's job is the admin-only half: which PATH needs which capability.
// It maps a path to a capability NAMESPACE, and admits anyone holding at least
// one `<namespace>.….read`. Written that way rather than as "the section's
// level" because the two answers have come apart: an exec granted `audit.read`
// must reach /audit, and no minimum level expresses that.
//
// THREE OUTCOMES, no `||` on a security check:
//   1. A baseline path (`/`, `/dashboard`, `/settings`, `/api/passkey`) — the
//      front door, the landing page and enrolling your own passkeys. Any
//      console level at all.
//   2. A path that resolves to a namespace — holds a read under it.
//   3. An UNMATCHED path — admin by level. The safety net is kept: a section
//      added to the app without an entry here is admin-only, not open to the
//      newest level.
//
// Deep import, NOT the '@badminton/shared' barrel. This module is pulled into
// the EDGE middleware through canAccess(), and the barrel re-exports the mail
// sender, which drags `resend` and a Supabase client in with it: importing it
// here took the built middleware from 321 KB to 843 KB, on every request, for
// three pure functions. Same reason push/send is imported by path elsewhere,
// and the same reason CAPABILITY_GATES lives in its own module — it is labels
// and prose for the editor, and no request needs it.
import {
  atLeast,
  effectiveCapabilities,
  type AccessLevel,
  type Permissions,
} from '@badminton/shared/src/utils/access-level';

// Re-exported so every existing `from '@/lib/permissions'` import keeps working
// and there is still ONE place in the admin app to look for these.
export {
  accessLevelFor,
  atLeast,
  consoleAccessLevelFor,
  effectiveCapabilities,
  hasConsoleAccess,
  isCapability,
  isInGoodStanding,
  permissionsOf,
  permissionTripleOf,
  permits,
  resolvePermissions,
  AREAS,
  CAPABILITIES,
  EDITOR_OFFERABLE,
  EXEC_BASELINE,
  PERMISSION_ROLES,
  PERMISSION_ROLE_LABELS,
  ROLE_DEFAULTS,
  TRAINER_BASELINE,
  UNRESTRICTED,
} from '@badminton/shared/src/utils/access-level';
export type {
  AccessLevel,
  Area,
  Capability,
  PermissionRole,
  Permissions,
  PermissionsInput,
} from '@badminton/shared/src/utils/access-level';

// WHICH SECTION ASKS FOR WHICH CAPABILITIES. The value is a dotted namespace,
// and a person may open the section when they hold at least one read beneath it.
//
// The level column that used to live here is gone. It said the same thing twice
// for every row but one, and the row where it did not — /fees — is the reason
// this shape changed.
const SECTION_NAMESPACE: { [pathPrefix: string]: string } = {
  '/announcements': 'announcements',
  '/matches': 'matches',
  '/tournaments': 'tournaments',
  '/sessions': 'sessions',
  '/seasons': 'seasons',
  // Finances. `fees` covers five ledgers with five separate reads, and an exec
  // holds exactly one of them — fees.expenses.read — because the club owner
  // asked for "execs can add expenses", not for the finance page. Club fees,
  // other income, reinstatements and the net position are separate capabilities
  // in nobody's baseline, and /fees/page.tsx enforces that by skipping their
  // FETCHES rather than hiding the rendered output: a hidden card whose query
  // still ran ships the figures into the RSC payload for anyone with devtools.
  // Same reasoning, and the same shape, as dashboard/page.tsx.
  //
  // This line is therefore NOT the whole story for this section, unlike every
  // other entry in this map. Anything that asks "may this person see club
  // money?" must ask for the capability the DATA needs — fees.clubfees.read,
  // fees.netposition.read — and must NOT reuse canAccess(…, '/fees'), which is
  // satisfied by the expenses read alone. The dashboard finance snapshot is the
  // one place that nearly did, and reusing this line is precisely what would
  // have leaked it.
  '/fees': 'fees',
  '/audit': 'audit',
  // Execs read the documents and may require a re-signature; only admins edit
  // the text. That split is three separate capabilities under `legal`, enforced
  // in the page and in the server actions — this line only decides who may open
  // the section.
  '/legal': 'legal',
  // Platform configuration, split out of /settings. Admin-only in BOTH halves,
  // unlike Legal: the club owner wants execs kept off the rating and account
  // rules entirely, not shown a read-only copy. Neither read is in any
  // baseline, and each page re-checks — this line only decides who may open the
  // section.
  '/ratings': 'ratings',
  '/accounts': 'accounts',
  // Execs run the roster: approve, edit, ban/unban, varsity notes. Granting
  // exec/admin is NOT part of that — the per-field split lives in
  // ./player-field-access.ts, and destructive actions (remove, merge) ask for
  // capabilities no baseline holds.
  //
  // Trainers get in here too, and ONLY to read: this is where the varsity notes
  // live, and finding the player you are writing about means seeing the list.
  // players.read is the whole of their claim on this section.
  '/players': 'players',
  '/disputes': 'disputes',
  '/walkovers': 'walkovers',
  '/challenges': 'challenges',
  // The permission editor. permissions.read is in no baseline, so it is
  // admin-only exactly as before, and it must STAY that way for anyone who is
  // not deliberately given it — someone who could reach it and hold
  // permissions.write could hand themselves anything they already have.
  '/permissions': 'permissions',
};

// Sub-routes whose namespace is NARROWER than the section they sit inside, and
// which would otherwise inherit it by prefix match. Tournament entry fees live
// at /tournaments/<id>/fees: execs run tournaments, but entry money is its own
// group under `tournaments.fees` and no baseline holds its read. Checked before
// the prefix map.
//
// This replaces the old ADMIN_ONLY_PATTERNS list, and the replacement is a
// namespace rather than a hard "admin": the whole point of the reshape is that
// an admin can hand this section to a treasurer without making them an admin.
const SECTION_PATTERNS: { pattern: RegExp; namespace: string }[] = [
  { pattern: /^\/tournaments\/[^/]+\/fees(\/|$)/, namespace: 'tournaments.fees' },
];

// What every console user keeps regardless of what they hold. These are not
// powers: the front door, the landing page, and enrolling your own passkeys.
// Without them a narrowed person would be locked out of the console entirely —
// including out of enrolling the passkey the console demands of them.
//
// Matched with the same segment-prefix rule as SECTION_NAMESPACE, so '/' is the
// root and nothing else. The console root only redirects to /dashboard
// (app/page.tsx), but middleware runs BEFORE the redirect, so without it every
// non-admin opening /admin — which is where the player app's "Exec Panel" link
// points — was bounced to /unauthorized.
const BASELINE_SECTIONS = ['/', '/dashboard', '/settings', '/api/passkey'];

// Does this path sit inside this section? Segment-aware, so '/players' never
// matches '/playersecret'. The one matching rule, shared by both maps.
function isUnder(pathname: string, prefix: string): boolean {
  return pathname === prefix || pathname.startsWith(prefix + '/');
}

// Longest-prefix lookup in a section map. Returns undefined when nothing
// matches; the caller treats that as admin-only.
function longestPrefixMatch<T>(map: { [prefix: string]: T }, pathname: string): T | undefined {
  let best = '';
  for (const prefix of Object.keys(map)) {
    if (isUnder(pathname, prefix) && prefix.length > best.length) best = prefix;
  }
  return best ? map[best] : undefined;
}

// The capability namespace this path belongs to, or undefined for a path no
// section claims.
function sectionNamespace(pathname: string): string | undefined {
  for (const { pattern, namespace } of SECTION_PATTERNS) {
    if (pattern.test(pathname)) return namespace;
  }
  return longestPrefixMatch(SECTION_NAMESPACE, pathname);
}

// Holds at least one READ beneath this namespace. Reads only: a section is a
// place you look at, and a write without its read is pruned by the resolver
// anyway, so "holds a write here but no read" is not a state that exists.
function holdsReadIn(capabilities: ReadonlySet<string>, namespace: string): boolean {
  const prefix = namespace + '.';
  for (const capability of capabilities) {
    if (capability.startsWith(prefix) && capability.endsWith('.read')) return true;
  }
  return false;
}

/**
 * May this person open this section?
 *
 * BOTH the level and the permissions are required, and the permissions
 * deliberately so: an optional argument would default to something at every
 * call site that forgot it, and every possible default is wrong in one
 * direction or the other.
 *
 * `{ kind: 'unrestricted' }` is byte-for-byte the behaviour that shipped before
 * any of this existed — it resolves to the level's baseline, and the baselines
 * are a transcription of what the levels could do.
 */
export function canAccess(
  level: AccessLevel | null,
  permissions: Permissions,
  pathname: string,
): boolean {
  if (level === null) return false;
  if (BASELINE_SECTIONS.some((prefix) => isUnder(pathname, prefix))) {
    return atLeast(level, 'trainer');
  }
  const namespace = sectionNamespace(pathname);
  // Fail closed on a path nobody claimed. An admin still gets in, so a new
  // section is reachable by the person who can fix the omission.
  if (namespace === undefined) return level === 'admin';
  return holdsReadIn(effectiveCapabilities(level, permissions), namespace);
}
