// WHO MAY OPEN THE ADMIN CONSOLE — the one implementation.
//
// This used to live only in apps/admin/src/lib/permissions.ts, which meant the
// members' app could not import it and grew its own hand-rolled copies instead:
// one in the top bar (`is_exec || is_trainer || role === 'admin'`) and a second,
// narrower one on the settings page (`is_exec || role === 'admin'`) that had
// never been told varsity trainers exist. The two disagreed, so a trainer saw
// the console link in the top bar and not in settings.
//
// It lives in @badminton/shared so both apps ask the same function. The
// admin-only pieces — which path needs which level — stay in the admin app.
//
// THREE ORDERED LEVELS — admin > exec > trainer. Each one's powers are a strict
// subset of the level above, so a requirement is expressed as a MINIMUM level
// and everything higher is admitted automatically.
//
// The string literals must stay byte-identical to what admin_access_level()
// returns in the database (migrations 00054, 00057); the admin middleware feeds
// that value straight into canAccess(). A mismatch resolves to null, fails
// closed, and locks the level out with no error surfaced anywhere.
export type AccessLevel = 'admin' | 'exec' | 'trainer';

// Higher number = more access. Used for every comparison so a new level is one
// entry here rather than a new branch in each caller.
const LEVEL_RANK: Record<AccessLevel, number> = {
  admin: 3,
  exec: 2,
  trainer: 1,
};

/** Does `level` reach at least `required`? The one place the ordering lives. */
export function atLeast(level: AccessLevel | null | undefined, required: AccessLevel): boolean {
  if (!level) return false;
  return LEVEL_RANK[level] >= LEVEL_RANK[required];
}

/** The role markers a player row carries. */
export type AccessLevelInput = {
  role?: string | null;
  is_exec?: boolean | null;
  is_trainer?: boolean | null;
};

/** Standing is a separate question from level — see isInGoodStanding. */
export type StandingInput = {
  is_banned?: boolean | null;
  status?: string | null;
  active_flag?: boolean | null;
};

// The HIGHEST level the markers grant, so they compose: someone who is both a
// trainer and an exec is simply an exec, and a trainer who is also an admin is
// an admin. A restriction always applies to the level a person resolves TO,
// never to a flag in isolation.
//
// This answers "what level do these markers grant" and nothing else. It does
// NOT check standing — see hasConsoleAccess for the gate a UI should use.
export function accessLevelFor(player: AccessLevelInput | null | undefined): AccessLevel | null {
  if (!player) return null;
  if (player.role === 'admin') return 'admin';
  if (player.is_exec === true) return 'exec';
  if (player.is_trainer === true) return 'trainer';
  return null;
}

// Standing gate, mirroring admin_access_level() in migration 00057 and the
// checks in the admin app's getAuthenticatedAtLeast(). A banned, suspended,
// pending or deactivated account holds no console level at all.
//
// COALESCE semantics matter: a row that is missing is_banned/active_flag (a
// narrowed select) must read as "not banned, still active" exactly as the SQL
// does, or a partial select silently locks someone out.
export function isInGoodStanding(player: StandingInput | null | undefined): boolean {
  if (!player) return false;
  if (player.is_banned === true) return false;
  if (player.status === 'suspended' || player.status === 'pending_approval') return false;
  if (player.active_flag === false) return false;
  return true;
}

// Standing FIRST, then level — the composition the console actually enforces.
// Use this to decide whether to SHOW a route into the console; the server-side
// gates (admin_access_level() in the middleware, getAuthenticatedAtLeast() in
// server actions) remain the security boundary.
export function consoleAccessLevelFor(
  player: (AccessLevelInput & StandingInput) | null | undefined,
): AccessLevel | null {
  if (!isInGoodStanding(player)) return null;
  return accessLevelFor(player);
}

/** Any console access at all, standing included. */
export function hasConsoleAccess(
  player: (AccessLevelInput & StandingInput) | null | undefined,
): boolean {
  return consoleAccessLevelFor(player) !== null;
}
