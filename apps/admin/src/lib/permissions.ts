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
import { atLeast, type AccessLevel } from '@badminton/shared/src/utils/access-level';

// Re-exported so every existing `from '@/lib/permissions'` import keeps working
// and there is still ONE place in the admin app to look for these.
export {
  accessLevelFor,
  atLeast,
  consoleAccessLevelFor,
  hasConsoleAccess,
  isInGoodStanding,
} from '@badminton/shared/src/utils/access-level';
export type { AccessLevel } from '@badminton/shared/src/utils/access-level';

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
  return atLeast(level, requiredLevel(pathname));
}
