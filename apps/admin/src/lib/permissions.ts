// Section-level access control for the admin app. The real security boundary is
// the server action (service-role bypasses RLS); this map is the single source of
// truth for which access level a section requires, shared by middleware and nav.
//
// 'exec' = admin OR exec may access. 'admin' = admin only.
// Anything not listed defaults to admin-only.
export type AccessLevel = 'admin' | 'exec';

export const SECTION_ACCESS: { [pathPrefix: string]: AccessLevel } = {
  '/dashboard': 'exec',
  '/announcements': 'exec',
  '/matches': 'exec',
  '/tournaments': 'exec',
  '/sessions': 'exec',
  '/seasons': 'exec',
  '/fees': 'admin',
  '/audit': 'admin',
  '/settings': 'admin',
  '/players': 'admin',
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

export function canAccess(level: AccessLevel | null, pathname: string): boolean {
  if (level === null) return false;
  if (level === 'admin') return true;
  // exec: only sections explicitly marked exec-allowed
  return requiredLevel(pathname) === 'exec';
}
