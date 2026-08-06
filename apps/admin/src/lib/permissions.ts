// Section-level access control for the admin app. The real security boundary is
// the server action (service-role bypasses RLS); this map is the single source of
// truth for which access level a section requires, shared by middleware and nav.
//
// 'exec' = admin OR exec may access. 'admin' = admin only.
// Anything not listed defaults to admin-only.
export type AccessLevel = 'admin' | 'exec';

const SECTION_ACCESS: { [pathPrefix: string]: AccessLevel } = {
  '/dashboard': 'exec',
  '/announcements': 'exec',
  '/matches': 'exec',
  '/tournaments': 'exec',
  '/sessions': 'exec',
  '/seasons': 'exec',
  '/fees': 'admin',
  '/audit': 'admin',
  '/settings': 'exec', // execs need it to enroll/manage their own passkeys
  '/api/passkey': 'exec', // passkey enrollment/verification endpoints
  // Execs run the roster: approve, edit, ban/unban, varsity notes. Granting
  // exec/admin is NOT part of that — the per-field split lives in
  // ./player-field-access.ts, and destructive actions (remove, merge) keep
  // getAdminPlayer() in the server action.
  '/players': 'exec',
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

// The one place a player row is turned into an access level. Server components
// need this to decide what to render; the middleware and sidebar get the same
// answer from the admin_access_level() SQL function (verified against the live
// database: role = 'admin' → 'admin', else is_exec → 'exec', else NULL). Keep
// the two in step — deriving the level inline in each page is how one rule ends
// up with two implementations that disagree.
export function accessLevelFor(
  player: { role?: string | null; is_exec?: boolean | null } | null | undefined,
): AccessLevel | null {
  if (!player) return null;
  if (player.role === 'admin') return 'admin';
  if (player.is_exec === true) return 'exec';
  return null;
}

export function canAccess(level: AccessLevel | null, pathname: string): boolean {
  if (level === null) return false;
  if (level === 'admin') return true;
  // exec: only sections explicitly marked exec-allowed
  return requiredLevel(pathname) === 'exec';
}
