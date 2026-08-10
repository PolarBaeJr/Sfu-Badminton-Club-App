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

// EXEC PORTFOLIOS — the club's four VP jobs. One `is_exec` boolean gave every
// exec identical access, so the VP of Tournaments could open the club's books
// and the VP of Finance could regenerate a draw.
//
// A CLOSED SET, not free-form capability strings: the club has a small number of
// NAMED JOBS, nothing enumerates a capability string, and a typo in one is a
// silent hole. Adding a fifth portfolio is an edit here plus the CHECK
// constraint in migration 00086 — deliberately two places, both of them lists.
//
// The strings must stay byte-identical to that CHECK constraint and to what
// admin_portfolio() returns; see portfolioOf() for what an unrecognised value
// does.
export type Portfolio = 'finance' | 'tournaments' | 'internal' | 'external';

export const PORTFOLIOS: readonly Portfolio[] = [
  'finance',
  'tournaments',
  'internal',
  'external',
] as const;

/** For the permission editor and anywhere a portfolio is shown to a human. */
export const PORTFOLIO_LABELS: Record<Portfolio, string> = {
  finance: 'Finance',
  tournaments: 'Tournaments',
  internal: 'Internal (roster)',
  external: 'External (legal & comms)',
};

/** Where a portfolio is stored. Separate from AccessLevelInput because holding
 *  one is not a level — it is a NARROWING of the exec level. */
export type PortfolioInput = {
  portfolio?: string | null;
};

/**
 * The portfolio a player row holds, or null for "none — this exec keeps exactly
 * today's access".
 *
 * `undefined` reads as null on purpose: the admin app selects `*` from players,
 * and until migration 00086 is applied to a given database the column does not
 * exist. Treating a missing column as "unknown, deny" would lock every exec out
 * of the console the moment this code deployed ahead of the migration.
 *
 * An unrecognised STRING is not treated as null, though — it is passed through
 * so that every comparison against a known portfolio fails and the holder is
 * left with the baseline. The CHECK constraint in 00086 makes it unreachable;
 * if it ever happens, the safe reading of a portfolio nobody can interpret is
 * "grants nothing", not "grants everything".
 */
export function portfolioOf(player: PortfolioInput | null | undefined): Portfolio | null {
  const value = player?.portfolio;
  if (value == null || value === '') return null;
  return value as Portfolio;
}

/**
 * Does an exec's portfolio cover work that belongs to `required`?
 *
 * ANSWERS ONLY THE PORTFOLIO QUESTION. The caller must already have checked the
 * LEVEL — this returns true for a trainer and for a signed-out visitor, because
 * neither of them holds a portfolio and neither is what this function is for.
 * Every caller sits behind atLeast()/getAuthenticatedAtLeast().
 *
 * - admin: superuser, unaffected by portfolios entirely.
 * - exec with no portfolio: today's behaviour, everything an exec has ever had.
 *   This is what makes 00086 a no-op on deploy — every existing row is NULL.
 * - exec with a portfolio: their portfolio's work and nothing else.
 */
export function portfolioPermits(
  level: AccessLevel | null | undefined,
  portfolio: Portfolio | null,
  required: Portfolio,
): boolean {
  if (level !== 'exec') return true;
  if (portfolio === null) return true;
  return portfolio === required;
}

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
