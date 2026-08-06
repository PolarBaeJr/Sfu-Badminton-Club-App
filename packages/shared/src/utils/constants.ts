import type { MatchFormat, PlayerStatus, EventType, TournamentEventType, TournamentMatchFormat, TournamentEventStatus } from '../types/database';

export const PLAYER_STATUS_LABELS: Record<PlayerStatus, string> = {
  competitive: 'Competitive',
  recreational: 'Recreational',
  pending_approval: 'Pending Approval',
  suspended: 'Suspended',
};

export const MATCH_FORMAT_LABELS: Record<MatchFormat, string> = {
  bo3_21: 'Best of 3 to 21',
  single_21: '1 Game to 21',
  single_15: '1 Game to 15',
  single_11: '1 Game to 11',
};

export const EVENT_TYPE_LABELS: Record<EventType, string> = {
  rated_challenge: 'Rated Challenge',
  casual: 'Casual Match',
  tournament: 'Tournament Match',
  trial: 'Official Trial',
  admin_entered: 'Admin Entered',
};

export const MAX_ACTIVE_CHALLENGES = 3;
export const CHALLENGE_EXPIRY_HOURS = 72;
// Nominal starting rating. The ladder uses an affine-stretched scale: everyone
// starts at 400 and strong players climb toward ~1300. This is a 2x stretch of
// the classic 1200-nominal / 400-divisor ELO scale, rebased to 400 — see
// ELO_SCALE in the engine. Every rating and delta is exactly 2x the classic
// value minus 2000, so the underlying win-probability dynamics are unchanged.
export const DEFAULT_ELO = 400;
// Hard bounds on any rating. Enforced everywhere a rating is written — live
// match results, tournament placement bonuses, and admin manual edits — so no
// rating can exceed the top of the ladder or go negative.
export const MAX_ELO = 1500;
export const MIN_ELO = 100;

// Clamp a rating to the allowed range.
//
// The bounds were hardcoded here and duplicated as LEAST(1500, GREATEST(100,…))
// in SQL, so raising the ceiling meant a migration AND a redeploy, in lockstep
// or the two engines would disagree. They now come from
// platform_settings.rating_defaults; the constants remain the fallback for any
// caller that has no settings to hand.
//
// An inverted or non-finite pair is ignored rather than honoured — max <= min
// collapses every rating to one value, and that must not be reachable from a
// settings typo.
export interface EloBounds {
  min?: number | null;
  max?: number | null;
}

export function resolveEloBounds(bounds?: EloBounds | null): { min: number; max: number } {
  // Number(null) is 0 and Number('') is 0, both finite — so an absent bound
  // would silently become a floor of zero rather than falling back. The SQL
  // side checks for NULL explicitly; this has to match it or the two engines
  // clamp differently.
  const min = toBound(bounds?.min);
  const max = toBound(bounds?.max);
  if (min === null || max === null || max <= min) {
    return { min: MIN_ELO, max: MAX_ELO };
  }
  return { min, max };
}

function toBound(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

export function clampElo(rating: number, bounds?: EloBounds | null): number {
  const { min, max } = resolveEloBounds(bounds);
  return Math.min(max, Math.max(min, rating));
}

export const CLUB_TIMEZONE = 'America/Vancouver';

// Session check-in window. session_checkin_open()
// (00008_richer_attendance.sql:56-58) is the enforcement source of truth, and
// it reads both values out of the platform_settings 'session_attendance' row
// on EVERY call. They are admin-editable at runtime, not constants.
//
// The pair below is a LAST-RESORT FALLBACK for callers that cannot reach the
// database — client components and pure formatters. Server callers should
// fetch the row and pass it through parseCheckinSettings(); see
// FALLBACK_CHECKIN_SETTINGS in session-window.ts.
//
// These track what prod is configured to today. That is a snapshot, not a
// contract: an admin editing the setting silently invalidates them. It has
// already bitten once — a client-only 'null' opening edge showed the Check In
// button for every upcoming session while the server (30 min) rejected it,
// fixed in 231b0af.
//
// Do NOT "restore" these to the 120 / null seeded by 00008. That seed only
// applied on first insert (ON CONFLICT DO NOTHING); prod has since been
// retuned away from it. Two stale tests asserted the seed values and were
// corrected in f677808 rather than the constants being reverted to match.
export const SESSION_DEFAULT_DURATION_MINUTES = 60;
// Check-in opens this many minutes before start (null = only a closing edge).
export const SESSION_CHECKIN_OPENS_MINUTES_BEFORE: number | null = 30;

// Shape of a session check-in QR token: randomBytes(24).toString('hex').
// The admin generator (getOrCreateSessionCheckinToken) and the player
// validator (checkInWithToken) must agree, so the pattern lives here rather
// than being inlined twice. Mirrors the calendar feed route's /^[0-9a-f]{48}$/.
export const CHECKIN_TOKEN_REGEX = /^[0-9a-f]{48}$/;

// Name of the Supabase auth cookie, pinned rather than derived.
//
// supabase-js builds it as `sb-<first hostname label>-auth-token` from
// NEXT_PUBLIC_SUPABASE_URL, so the session is silently tied to the domain: the
// current badminton.polardev.org yields "sb-badminton-auth-token", while
// sfubadminton.com would yield "sb-sfubadminton-auth-token". Changing that URL
// would therefore make every existing cookie unreadable and sign everyone out,
// re-triggering passkey verification with it.
//
// This value is exactly what the library derives today, so pinning it changes
// nothing now — and means the pending move off polardev.org becomes a plain
// config edit that sessions survive. Do not "tidy" the badminton- prefix: the
// string must keep matching cookies already in browsers.
export const AUTH_COOKIE_NAME = 'sb-badminton-auth-token';

// Domain the auth cookie is scoped to, or undefined for a host-only cookie.
//
// Host-only (unset) is what shipped originally: the cookie is set for
// sfubadminton.com and is NEVER sent to admin.sfubadminton.com, so signing in
// on the player app leaves you signed out on the admin console. Setting this to
// ".sfubadminton.com" makes one session cover the apex and every subdomain.
//
// Why NEXT_PUBLIC_ and not a plain server var: the BROWSER client writes this
// cookie too — every token refresh and every sign-out goes through
// document.cookie — and Next only inlines NEXT_PUBLIC_* into client bundles. A
// server-only variable would give server-writes-with-domain plus
// browser-writes-without, which manufactures a second cookie of the same name
// on every refresh. That duplicate is the precise failure this feature exists
// to avoid, so the two halves must read the same value.
//
// Consequence: this is baked at BUILD time (Dockerfile ARG -> compose/CI build
// arg). Adding it to the Pi's runtime .env alone does nothing.
//
// Unset is also the correct default for local dev: a `domain` of ".localhost"
// is rejected by some browsers, which would drop the cookie entirely.
export const AUTH_COOKIE_DOMAIN: string | undefined =
  process.env.NEXT_PUBLIC_AUTH_COOKIE_DOMAIN || undefined;

// The single object every createServerClient/createBrowserClient call passes as
// `cookieOptions`. @supabase/ssr spreads it over its DEFAULT_COOKIE_OPTIONS for
// both writes and deletions, so `domain` lands on both — which is what makes a
// domain-scoped cookie deletable again.
//
// With AUTH_COOKIE_DOMAIN unset the object is `{ name }`, exactly what the call
// sites passed before, so the emitted Set-Cookie is byte-identical to today.
export const AUTH_COOKIE_OPTIONS: { name: string; domain?: string } = AUTH_COOKIE_DOMAIN
  ? { name: AUTH_COOKIE_NAME, domain: AUTH_COOKIE_DOMAIN }
  : { name: AUTH_COOKIE_NAME };

// Every cookie name @supabase/ssr derives from AUTH_COOKIE_NAME:
//   sb-badminton-auth-token                    the session
//   sb-badminton-auth-token.0 .1 …             chunks, when the session exceeds ~3.2 kB
//   sb-badminton-auth-token-code-verifier      PKCE verifier (storageKey is the cookie name)
// The verifier matters as much as the session: a duplicated one fails the code
// exchange outright, which is "cannot log in", not "logged out".
export function isAuthCookieName(name: string): boolean {
  if (!name.startsWith(AUTH_COOKIE_NAME)) return false;
  const suffix = name.slice(AUTH_COOKIE_NAME.length);
  return suffix === '' || /^\.\d+$/.test(suffix) || /^-code-verifier(\.\d+)?$/.test(suffix);
}

// A Set-Cookie line that expires the HOST-ONLY cookie of this name and nothing
// else. Cookies are keyed by (name, domain, path), so a deletion that omits
// Domain can only ever match the host-only variant — the domain-scoped cookie
// written alongside it in the same response survives untouched. Path and
// SameSite mirror @supabase/ssr's DEFAULT_COOKIE_OPTIONS so the key matches;
// Secure is deliberately absent, matching the library (and keeping it valid
// over plain http on localhost).
function hostOnlyClear(name: string): string {
  return `${name}=; Path=/; Max-Age=0; SameSite=Lax`;
}

/**
 * Companion deletions to emit alongside a domain-scoped cookie write.
 *
 * The migration hazard: the day the domain is switched on, a browser still
 * holds the old host-only cookie. The moment the server writes the new
 * domain-scoped one, BOTH exist under the same name, both are sent on every
 * request, and header order is explicitly not something a server may rely on
 * (RFC 6265 §5.4). Reading the stale one presents as a login loop.
 *
 * Killing the host-only variant in the same response that creates the
 * domain-scoped one means the overlap never lasts beyond a single Set-Cookie
 * batch. Because @supabase/ssr routes deletions through the same setAll, this
 * also fixes the mirror-image problem: a sign-out would otherwise clear only
 * the domain-scoped cookie and leave the host-only one alive and valid.
 *
 * Returns raw header strings rather than calling response.cookies.set(): Next's
 * ResponseCookies is a map keyed by NAME ALONE, so setting the same name twice
 * silently drops the first — which would delete the session instead of moving
 * it. These must be appended with headers.append('set-cookie', …).
 *
 * No-op when AUTH_COOKIE_DOMAIN is unset.
 */
export function hostOnlyAuthCookieClears(
  cookiesToSet: readonly { name: string }[]
): string[] {
  if (!AUTH_COOKIE_DOMAIN) return [];
  const seen = new Set<string>();
  const clears: string[] = [];
  for (const { name } of cookiesToSet) {
    if (!isAuthCookieName(name) || seen.has(name)) continue;
    seen.add(name);
    clears.push(hostOnlyClear(name));
  }
  return clears;
}

/**
 * Safety net for duplicates the companion deletions above cannot reach — chiefly
 * a browser-side token refresh (which writes the domain-scoped cookie through
 * the library's own document.cookie path) and server-action writes through
 * next/headers, whose cookie store offers no way to append a second header.
 *
 * Reads the RAW Cookie header on purpose: Next's RequestCookies de-duplicates
 * last-wins, so by the time you reach request.cookies the second copy is
 * invisible. A name appearing twice can only be the host-only/domain-scoped
 * pair, and the host-only one is always the stale side.
 *
 * Limit worth knowing: this fires on the request that already carried the
 * duplicate, so that one request may still have read the stale cookie. Worst
 * case is a single re-login, not a loop — the next request is unambiguous.
 * Deliberately does NOT redirect: middleware also handles POST server actions,
 * and replaying those through a redirect is a far worse failure than one
 * ambiguous read.
 *
 * No-op when AUTH_COOKIE_DOMAIN is unset.
 */
export function duplicateAuthCookieClears(cookieHeader: string | null | undefined): string[] {
  if (!AUTH_COOKIE_DOMAIN || !cookieHeader) return [];
  const counts = new Map<string, number>();
  for (const pair of cookieHeader.split(';')) {
    const eq = pair.indexOf('=');
    if (eq < 0) continue;
    const name = pair.slice(0, eq).trim();
    if (!isAuthCookieName(name)) continue;
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  const clears: string[] = [];
  counts.forEach((count, name) => {
    if (count > 1) clears.push(hostOnlyClear(name));
  });
  return clears;
}

/**
 * Browser-side counterpart, to be called after supabase.auth.signOut().
 *
 * createBrowserClient is given no `cookies` implementation, so its deletions go
 * through the library's own document.cookie path and carry the domain — leaving
 * any host-only cookie of the same name alive. During the migration window that
 * makes "sign out" appear to do nothing: the next navigation still finds a
 * valid session. Clearing the host-only variants here closes that gap without
 * reimplementing the library's cookie handling.
 *
 * No-op when AUTH_COOKIE_DOMAIN is unset, and outside a browser.
 */
export function clearHostOnlyAuthCookies(): void {
  if (!AUTH_COOKIE_DOMAIN || typeof document === 'undefined') return;
  const names = new Set<string>();
  for (const pair of document.cookie.split(';')) {
    const eq = pair.indexOf('=');
    if (eq < 0) continue;
    const name = pair.slice(0, eq).trim();
    if (isAuthCookieName(name)) names.add(name);
  }
  names.forEach((name) => {
    document.cookie = hostOnlyClear(name);
  });
}

export const PROVISIONAL_THRESHOLD = 8;

// Margin-of-victory bonus applied when a multi-game match ends in a sweep
// (2-0 / 3-0). Applies to both sides: the winner gains slightly more, the loser
// drops slightly more. Kept small on purpose — see getMarginMultiplier().
export const SWEEP_MARGIN_MULTIPLIER = 1.15;
export const MAX_RATED_PER_SESSION = 3;
export const MAX_REPEAT_OPPONENT_7DAYS = 2;
export const GRACE_PERIOD_MINUTES = 15;
export const LATE_WITHDRAWAL_HOURS = 24;
export const WALKOVER_REVIEW_HOURS = 48;
export const INACTIVITY_DAYS = 45;
// Fallback only, like INACTIVITY_DAYS above: the live value is
// platform_settings.inactivity_rules.purge_after_days (00063, 365 on prod).
// Used when that read fails, so the retention notice still quotes a number
// rather than "undefined days".
export const INACTIVITY_PURGE_DAYS = 365;

// Absolute ELO point awards for tournament placement. Doubled from the classic
// 16/10/6/3 (singles) and 14/9/5/2 (doubles) to match the 2x-stretched scale.
//
// FALLBACK ONLY. The live values come from platform_settings.tournament_bonuses
// via parseTournamentBonusSettings() (utils/tournament-bonuses.ts); these apply
// only when a key is absent or unparseable. Do not read this table directly at
// an award or display site — that is how the panel and the engine drifted apart
// in the first place.
export const PLACEMENT_BONUSES = {
  singles: { champion: 32, finalist: 20, semifinalist: 12, quarterfinalist: 6 },
  doubles: { champion: 28, finalist: 18, semifinalist: 10, quarterfinalist: 4 },
} as const;

export const COLORS = {
  primary: '#1A1A2E',
  accent: '#E94560',
  success: '#10B981',
  warning: '#F59E0B',
  danger: '#EF4444',
  surface: '#0F3460',
  background: '#16213E',
} as const;

// =============================================
// Tournament Event System Constants
// =============================================

export const TOURNAMENT_EVENT_TYPE_LABELS: Record<TournamentEventType, string> = {
  mens_singles: "Men's Singles",
  womens_singles: "Women's Singles",
  open_singles: 'Open Singles',
  mens_doubles: "Men's Doubles",
  womens_doubles: "Women's Doubles",
  mixed_doubles: 'Mixed Doubles',
  open_doubles: 'Open Doubles',
};

export const TOURNAMENT_MATCH_FORMAT_LABELS: Record<TournamentMatchFormat, string> = {
  best_of_3_to_21: 'Best of 3 to 21',
  one_game_21: '1 Game to 21',
  one_game_15: '1 Game to 15',
  one_game_11: '1 Game to 11',
};

export const TOURNAMENT_EVENT_STATUS_LABELS: Record<TournamentEventStatus, string> = {
  registration: 'Registration',
  checkin: 'Check-In',
  bracket_generated: 'Bracket Generated',
  live: 'Live',
  completed: 'Completed',
};

export const TOURNAMENT_EVENT_STATUS_COLORS: Record<TournamentEventStatus, string> = {
  registration: '#3B82F6',
  checkin: '#F59E0B',
  bracket_generated: '#8B5CF6',
  live: '#10B981',
  completed: '#6B7280',
};

export function isDoublesEvent(eventType: TournamentEventType): boolean {
  return ['mens_doubles', 'womens_doubles', 'mixed_doubles', 'open_doubles'].includes(eventType);
}

export function getRoundName(roundNumber: number, totalRounds: number): string {
  const roundsFromEnd = totalRounds - roundNumber + 1;
  if (roundsFromEnd === 1) return 'Final';
  if (roundsFromEnd === 2) return 'Semi-Final';
  if (roundsFromEnd === 3) return 'Quarter-Final';
  const playersInRound = Math.pow(2, roundsFromEnd);
  return `Round of ${playersInRound}`;
}

export function getMaxGamesForFormat(matchFormat: TournamentMatchFormat): number {
  return matchFormat === 'best_of_3_to_21' ? 3 : 1;
}

export function nextPowerOf2(n: number): number {
  let p = 1;
  while (p < n) p *= 2;
  return p;
}

// Per-format scoring rules: how many games the match is a best-of, the target a
// game is played to, and the deuce cap. Rally scoring: reach the target, but win
// by two — so at 20-20 play continues (22-20, 23-21, …) until the cap, where the
// next point takes it (30-29). 21-20 is therefore NOT a legal finish, while
// 30-29 is.
//
// NOTE: the 21-point cap of 30 is the BWF rule. The caps for the 15- and
// 11-point club formats are our own convention — adjust here if the club plays
// them differently; nothing else needs to change.
// One cap rule everywhere, preset or custom: target + 9, mirroring the BWF
// 21 -> 30. Earlier this file guessed different caps per format; a single rule
// is easier to reason about and is what the custom formats need anyway.
export function pointsCap(target: number): number {
  return target + 9;
}

export const CUSTOM_FORMAT_BOUNDS = {
  minGames: 1, maxGames: 7,   // best-of must be odd so a majority exists
  minPoints: 5, maxPoints: 30,
} as const;

/**
 * Is this a best-of a match could actually be decided by? An even best-of has
 * no majority, so it can end level and never resolve — the reason the CHECK in
 * migration 00031 demands an odd number. Typed into a form rather than picked
 * from a list, that is a mistake worth catching before the insert does.
 */
export function isLegalCustomGames(gamesPerMatch: number): boolean {
  const { minGames, maxGames } = CUSTOM_FORMAT_BOUNDS;
  return Number.isInteger(gamesPerMatch)
    && gamesPerMatch % 2 === 1
    && gamesPerMatch >= minGames
    && gamesPerMatch <= maxGames;
}

/** Companion to isLegalCustomGames for the points half of the shape. */
export function isLegalCustomPoints(pointsPerGame: number): boolean {
  const { minPoints, maxPoints } = CUSTOM_FORMAT_BOUNDS;
  return Number.isInteger(pointsPerGame)
    && pointsPerGame >= minPoints
    && pointsPerGame <= maxPoints;
}

/**
 * The one line of help that sits under a typed "best of X to Y" pair: what is
 * wrong with it, or — once it is valid — the rule the scores will be judged
 * against, since the cap is not obvious from the target. Shared so every form
 * that lets the numbers be typed says the same thing.
 */
export function customFormatHint(gamesPerMatch: number, pointsPerGame: number): string {
  const { minGames, maxGames, minPoints, maxPoints } = CUSTOM_FORMAT_BOUNDS;
  if (!isLegalCustomGames(gamesPerMatch)) {
    return `Best of must be an odd number from ${minGames} to ${maxGames} — an even best-of can end level, so it could never be decided.`;
  }
  if (!isLegalCustomPoints(pointsPerGame)) {
    return `Points per game must be between ${minPoints} and ${maxPoints}.`;
  }
  return `A game is won by two clear points, or at ${pointsCap(pointsPerGame)}.`;
}

export const FORMAT_RULES: Record<MatchFormat, { bestOf: number; target: number; cap: number }> = {
  bo3_21:    { bestOf: 3, target: 21, cap: pointsCap(21) },
  single_21: { bestOf: 1, target: 21, cap: pointsCap(21) },
  single_15: { bestOf: 1, target: 15, cap: pointsCap(15) },
  single_11: { bestOf: 1, target: 11, cap: pointsCap(11) },
};

/**
 * Rules for a match that may define its own shape. Custom values win when
 * present; otherwise the preset applies. Mirrors effective_target/
 * effective_best_of in migration 00031.
 */
export function getRulesFor(
  format: AnyMatchFormat,
  gamesPerMatch?: number | null,
  pointsPerGame?: number | null,
): { bestOf: number; target: number; cap: number } {
  const preset = getFormatRules(format);
  const target = pointsPerGame ?? preset.target;
  return { bestOf: gamesPerMatch ?? preset.bestOf, target, cap: pointsCap(target) };
}

/**
 * The format columns a tournament event carries. games_per_match /
 * points_per_game are the typed shape added in 00046 and are NULL on every
 * event created before it, which is why they are optional here — the enum
 * remains the meaning of an event that never set them.
 */
export interface EventMatchShape {
  match_format: TournamentMatchFormat | string;
  games_per_match?: number | null;
  points_per_game?: number | null;
}

/**
 * Scoring rules for a tournament event: the typed shape when it has one, the
 * match_format enum otherwise. Every caller that used to read match_format
 * alone should go through this, or an event set to "1 game to 15" would still
 * be scored — and rated — as best of 3 to 21.
 */
export function getEventRules(event: EventMatchShape): { bestOf: number; target: number; cap: number } {
  return getRulesFor(event.match_format as AnyMatchFormat, event.games_per_match, event.points_per_game);
}

/** True when this event overrides the enum with an explicit shape. */
export function hasTypedFormat(event: EventMatchShape): boolean {
  return event.games_per_match != null || event.points_per_game != null;
}

/**
 * Human label for whatever shape an event is played at, derived from the rules
 * rather than the enum so a custom "best of 5 to 15" reads the same way the
 * four presets do — the preset strings in TOURNAMENT_MATCH_FORMAT_LABELS are
 * exactly what this produces for them.
 */
export function describeMatchShape(event: EventMatchShape): string {
  const { bestOf, target } = getEventRules(event);
  return bestOf > 1 ? `Best of ${bestOf} to ${target}` : `1 Game to ${target}`;
}

/** Elo weight for a custom shape — mirrors derived_format_weight (00031). */
export function derivedFormatWeight(bestOf: number, target: number): number {
  const raw = (target / 21) * (bestOf > 1 ? 1.25 : 1.0);
  return Math.min(1.5, Math.max(0.25, raw));
}

// Tournaments carry their own format enum with the same four shapes, so the
// rules are mapped rather than duplicated — one source of truth for what a
// legal score is, whether the match came from a challenge or a bracket.
export const TOURNAMENT_FORMAT_RULES: Record<TournamentMatchFormat, { bestOf: number; target: number; cap: number }> = {
  best_of_3_to_21: FORMAT_RULES.bo3_21,
  one_game_21:     FORMAT_RULES.single_21,
  one_game_15:     FORMAT_RULES.single_15,
  one_game_11:     FORMAT_RULES.single_11,
};

export type AnyMatchFormat = MatchFormat | TournamentMatchFormat;

export function getFormatRules(format: AnyMatchFormat): { bestOf: number; target: number; cap: number } {
  const table = { ...FORMAT_RULES, ...TOURNAMENT_FORMAT_RULES } as Record<
    string,
    { bestOf: number; target: number; cap: number } | undefined
  >;
  // Unknown format: fall back to the 21-point rules rather than throwing, so a
  // future enum member can never crash score entry before it's mapped here.
  return table[format] ?? FORMAT_RULES.single_21;
}

/** Highest score legally reachable in this format — the deuce cap. */
export function getMaxScoreForFormat(format: AnyMatchFormat): number {
  return getFormatRules(format).cap;
}

/**
 * Is this a legal way for a single game to end?
 *
 * Legal finishes, for target T and cap C:
 *  - exactly T, with the loser at most T-2      (21-19, 21-0)
 *  - above T but below C, winning by exactly 2  (22-20, 23-21, … 29-27)
 *  - at C, with the loser on C-2 or C-1         (30-28 win-by-two, 30-29 the cap)
 *
 * `timeExceeded` switches to the relaxed rules below — pass it only when the
 * exec has said the match was cut short (00047).
 */
export function isLegalGameScore(
  a: number,
  b: number,
  format: AnyMatchFormat,
  gamesPerMatch?: number | null,
  pointsPerGame?: number | null,
  timeExceeded?: boolean,
): boolean {
  if (timeExceeded) return isLegalTimeExceededScore(a, b, format, gamesPerMatch, pointsPerGame);
  const { target, cap } = getRulesFor(format, gamesPerMatch, pointsPerGame);
  const winner = Math.max(a, b);
  const loser = Math.min(a, b);
  if (a === b) return false;                       // a game must be won
  if (loser < 0 || winner > cap) return false;
  if (winner === target) return loser <= target - 2;
  if (winner > target && winner < cap) return winner - loser === 2;
  if (winner === cap) return loser >= cap - 2;
  return false;                                    // winner never reached target
}

/**
 * Is this a legal way for a game to have been STOPPED?
 *
 * Club sessions run to a clock, so the exec can call time mid-game and the
 * score at that moment is the result (00047). Such a game never reached the
 * target and owes nothing to the two-point margin — 15-2 in a game to 21 is
 * exactly what a cut-short game looks like — so both of those rules are off.
 *
 * What survives is everything that stays true no matter when play stopped:
 *  - not a tie: someone has to have been ahead for there to be a winner
 *  - no negatives
 *  - neither side above the cap: past the cap the game would already have
 *    ended on its own, so the clock could not have been what stopped it
 *
 * The cap is whatever this format's rules say (getRulesFor -> pointsCap), so a
 * custom 15-point event gets 24, not the 21-point 30.
 */
export function isLegalTimeExceededScore(
  a: number,
  b: number,
  format: AnyMatchFormat,
  gamesPerMatch?: number | null,
  pointsPerGame?: number | null,
): boolean {
  const { cap } = getRulesFor(format, gamesPerMatch, pointsPerGame);
  // Integers only. The strict path is pinned to whole numbers by its equalities
  // against target and cap; this one compares nothing but bounds, so without
  // the check a client posting 15.5 would sail through.
  if (!Number.isInteger(a) || !Number.isInteger(b)) return false;
  if (a === b) return false;                       // no winner, no result
  return Math.min(a, b) >= 0 && Math.max(a, b) <= cap;
}

/**
 * How many games a best-of-N match should contain, given who won each.
 * A match stops the moment someone clinches, so a best-of-3 is 2 games (2-0) or
 * 3 (2-1) — never 3-0, because game three would never have been played.
 */
export function isLegalGameCount(
  winnerGames: number,
  loserGames: number,
  format: AnyMatchFormat,
  gamesPerMatch?: number | null,
): boolean {
  const { bestOf } = getRulesFor(format, gamesPerMatch);
  const needed = Math.floor(bestOf / 2) + 1;
  if (winnerGames !== needed) return false;        // winner must reach exactly the clinch
  return loserGames <= needed - 1;                 // and no games played after it
}
