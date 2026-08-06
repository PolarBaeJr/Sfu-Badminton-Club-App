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
// The string literals must stay byte-identical to what admin_access_level()
// returns in the database (migration 00054); the middleware feeds that value
// straight into canAccess(). A mismatch resolves to null, fails closed, and
// locks the level out with no error surfaced anywhere.
export type AccessLevel = 'admin' | 'exec' | 'trainer';

// Higher number = more access. Used for every comparison so a new level is one
// entry here rather than a new branch in each caller.
const LEVEL_RANK: Record<AccessLevel, number> = {
  admin: 3,
  exec: 2,
  trainer: 1,
};

const SECTION_ACCESS: { [pathPrefix: string]: AccessLevel } = {
  // Where sign-in lands. Trainers need to get through the front door; the
  // dashboard gates each tile with canAccess() so they only see their own.
  '/dashboard': 'trainer',
  '/announcements': 'exec',
  '/matches': 'exec',
  '/tournaments': 'exec',
  '/sessions': 'exec',
  '/seasons': 'exec',
  '/fees': 'admin',
  '/audit': 'admin',
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
};

// Admin-only sub-routes that sit *under* an exec-allowed section and would
// otherwise inherit its access via prefix match. Tournament entry fees live at
// /tournaments/<id>/fees — execs run tournaments, but all money handling is
// admin-only. Checked before prefix matching.
const ADMIN_ONLY_PATTERNS: RegExp[] = [
  /^\/tournaments\/[^/]+\/fees(\/|$)/,
];

// Resolve a pathname to the access level its section requires (longest-prefix
// match). Unmatched paths default to admin-only.
function requiredLevel(pathname: string): AccessLevel {
  if (ADMIN_ONLY_PATTERNS.some((re) => re.test(pathname))) return 'admin';
  let best = '';
  for (const prefix of Object.keys(SECTION_ACCESS)) {
    if ((pathname === prefix || pathname.startsWith(prefix + '/')) && prefix.length > best.length) {
      best = prefix;
    }
  }
  return best ? SECTION_ACCESS[best]! : 'admin';
}

// Does `level` reach at least `required`? The one place the ordering is
// expressed, so server actions and pages can ask "is this caller at least an
// exec?" without re-listing which levels those are.
export function atLeast(level: AccessLevel | null | undefined, required: AccessLevel): boolean {
  if (!level) return false;
  return LEVEL_RANK[level] >= LEVEL_RANK[required];
}

// The one place a player row is turned into an access level. Server components
// need this to decide what to render; the middleware and sidebar get the same
// answer from the admin_access_level() SQL function (verified against the live
// database: role = 'admin' → 'admin', else is_exec → 'exec', else is_trainer →
// 'trainer', else NULL). Keep the two in step — deriving the level inline in
// each page is how one rule ends up with two implementations that disagree.
//
// Returns the HIGHEST level held, so the markers compose: someone who is both a
// trainer and an exec is simply an exec, and a trainer who is also an admin is
// an admin. The restriction always applies to the level a person resolves TO,
// never to a flag in isolation.
export function accessLevelFor(
  player: { role?: string | null; is_exec?: boolean | null; is_trainer?: boolean | null } | null | undefined,
): AccessLevel | null {
  if (!player) return null;
  if (player.role === 'admin') return 'admin';
  if (player.is_exec === true) return 'exec';
  if (player.is_trainer === true) return 'trainer';
  return null;
}

export function canAccess(level: AccessLevel | null, pathname: string): boolean {
  if (level === null) return false;
  return atLeast(level, requiredLevel(pathname));
}
