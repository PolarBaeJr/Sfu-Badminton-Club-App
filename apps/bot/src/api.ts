// Client for the badminton app's /api/discord/* surface.
//
// The bot NEVER talks to the database. Every answer comes from the app, through
// the same services the website uses, so registration rules, visibility rules and
// fee checks cannot drift between the two clients. That is the whole reason this
// indirection exists — see docs/design/discord-bot.md.

export interface LeaderboardEntry {
  rank: number;
  name: string;
  handle: string | null;
  rating: number;
  provisional: boolean;
  wins: number;
  losses: number;
  streak: number;
}

export interface LeaderboardPage {
  ladder: 'singles' | 'doubles' | 'points';
  page: number;
  totalPages: number;
  totalPlayers: number;
  entries: LeaderboardEntry[];
}

export interface SessionSummary {
  id: string;
  name: string | null;
  date: string;
  startTime: string | null;
  endTime: string | null;
  startsAt: string | null;
  location: string | null;
  track: string | null;
  going: number | null;
}

export class AppApiError extends Error {}

// Deliberately short. Discord's interaction deadline is 3 seconds end to end, so
// a request that has not answered in 2.5s cannot be rendered in time anyway — and
// failing fast leaves room to reply with something useful instead of timing out
// silently, which Discord surfaces as "the application did not respond".
const TIMEOUT_MS = 2500;

async function get<T>(path: string): Promise<T> {
  const base = process.env.APP_API_URL;
  const secret = process.env.DISCORD_SERVICE_SECRET;
  if (!base) throw new AppApiError('APP_API_URL is not set');
  if (!secret) throw new AppApiError('DISCORD_SERVICE_SECRET is not set');

  const response = await fetch(new URL(path, base), {
    headers: { authorization: `Bearer ${secret}` },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });

  if (!response.ok) {
    // The body may carry an error code, but it may also be an HTML error page
    // from something in front of the app. Never interpolate it into a Discord
    // reply; log the status and keep the user-facing message generic.
    throw new AppApiError(`GET ${path} -> ${response.status}`);
  }

  return (await response.json()) as T;
}

export function fetchLeaderboard(
  ladder: string,
  page: number
): Promise<LeaderboardPage> {
  const params = new URLSearchParams({ ladder, page: String(page) });
  return get<LeaderboardPage>(`/api/discord/leaderboard?${params}`);
}

export function fetchSessions(): Promise<{ sessions: SessionSummary[] }> {
  return get<{ sessions: SessionSummary[] }>('/api/discord/sessions');
}

/** Which servers to manage, their role ids, and where the audit log goes. */
export interface BotConfigPayload {
  guilds: { guildId: string; roles: Record<string, string> }[];
  auditChannelId: string | null;
}

export function fetchBotConfig(): Promise<BotConfigPayload> {
  return get<BotConfigPayload>('/api/discord/config');
}

/**
 * Every linked member and what the app currently believes about them.
 *
 * The sweep's input. `state` is null for a link the app can no longer resolve to
 * a player — a deleted account, a merged-away duplicate — which the sync treats
 * as "strip everything".
 */
export interface LinkedMemberRow {
  discordUserId: string;
  state: {
    status: 'competitive' | 'recreational' | 'pending_approval' | 'suspended';
    membershipType: 'internal' | 'alumni' | 'external';
    isExec: boolean;
    isBanned: boolean;
    permissionRole: 'finance' | 'tournaments' | 'internal' | 'external' | 'custom' | null;
    capabilities: string[];
  } | null;
}

/**
 * Deliberately NOT on the 2.5s interaction budget. This one is called by the
 * reconciliation sweep, which nobody is watching a "thinking..." spinner for,
 * and the whole roster does not arrive in the time a single slash command has.
 */
export async function fetchLinkedMembers(): Promise<LinkedMemberRow[]> {
  const base = process.env.APP_API_URL;
  const secret = process.env.DISCORD_SERVICE_SECRET;
  if (!base) throw new AppApiError('APP_API_URL is not set');
  if (!secret) throw new AppApiError('DISCORD_SERVICE_SECRET is not set');

  const response = await fetch(new URL('/api/discord/members', base), {
    headers: { authorization: `Bearer ${secret}` },
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new AppApiError(`GET /api/discord/members -> ${response.status}`);

  const body = (await response.json()) as { members?: LinkedMemberRow[] };
  return body.members ?? [];
}

/**
 * Tell the app which tombstoned accounts are now actually clean.
 *
 * Failure here is deliberately NOT fatal to the sweep: the roles have already
 * been removed by the time this runs, and the only cost of the tombstone
 * surviving is that the next sweep visits an account that has nothing left to
 * strip. Losing the sweep's result over a bookkeeping call would be the worse
 * trade.
 */
export async function clearRevocations(discordUserIds: readonly string[]): Promise<void> {
  if (discordUserIds.length === 0) return;

  const base = process.env.APP_API_URL;
  const secret = process.env.DISCORD_SERVICE_SECRET;
  if (!base) throw new AppApiError('APP_API_URL is not set');
  if (!secret) throw new AppApiError('DISCORD_SERVICE_SECRET is not set');

  const response = await fetch(new URL('/api/discord/members', base), {
    method: 'DELETE',
    headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json' },
    body: JSON.stringify({ discordUserIds }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) {
    throw new AppApiError(`DELETE /api/discord/members -> ${response.status}`);
  }
}

/**
 * Mint a one-time link token and get back the URL the member should open.
 *
 * ON THE INTERACTION BUDGET, unlike fetchLinkedMembers: Discord gives roughly
 * three seconds for a first response, so this uses a short timeout and would
 * rather fail fast into a "try again" than hold the interaction open until
 * Discord gives up on it and shows the member "the application did not respond".
 */
export async function mintLinkToken(
  discordUserId: string,
  guildId: string | null
): Promise<{ url: string; expiresAt: string }> {
  const base = process.env.APP_API_URL;
  const secret = process.env.DISCORD_SERVICE_SECRET;
  const publicBase = process.env.APP_PUBLIC_URL;
  if (!base) throw new AppApiError('APP_API_URL is not set');
  if (!secret) throw new AppApiError('DISCORD_SERVICE_SECRET is not set');
  // The member's browser has to reach this, so it cannot be the in-cluster
  // http://player:3000 that APP_API_URL is. Separate variable on purpose.
  if (!publicBase) throw new AppApiError('APP_PUBLIC_URL is not set');

  const response = await fetch(new URL('/api/discord/link-tokens', base), {
    method: 'POST',
    headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json' },
    body: JSON.stringify({ discordUserId, guildId }),
    signal: AbortSignal.timeout(2_000),
  });
  if (!response.ok) {
    throw new AppApiError(`POST /api/discord/link-tokens -> ${response.status}`);
  }

  const body = (await response.json()) as { token?: string; expiresAt?: string };
  if (!body.token || !body.expiresAt) throw new AppApiError('mint returned no token');

  // Path segment rather than ?token=. Query strings are the part of a URL that
  // leaks most readily — into referrers, into analytics, into server logs that
  // record the query and not the path.
  return {
    url: new URL(`/link/${body.token}`, publicBase).toString(),
    expiresAt: body.expiresAt,
  };
}

/** Remove the caller's link. Returns false when they were not linked at all. */
export async function deleteLink(discordUserId: string): Promise<boolean> {
  const base = process.env.APP_API_URL;
  const secret = process.env.DISCORD_SERVICE_SECRET;
  if (!base) throw new AppApiError('APP_API_URL is not set');
  if (!secret) throw new AppApiError('DISCORD_SERVICE_SECRET is not set');

  const response = await fetch(new URL('/api/discord/link', base), {
    method: 'DELETE',
    headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json' },
    body: JSON.stringify({ discordUserId }),
    signal: AbortSignal.timeout(2_000),
  });
  if (!response.ok) throw new AppApiError(`DELETE /api/discord/link -> ${response.status}`);

  const body = (await response.json()) as { unlinked?: boolean };
  return body.unlinked === true;
}

/**
 * Write a guild's role map, for /setup.
 *
 * Its own timeout rather than the 2.5s shared one: /setup answers Discord with
 * a deferred reply before it gets here, so it is not racing the 3-second
 * interaction deadline, and it may be creating nine roles first. Failing this
 * at 2.5s would abandon a write that was about to succeed and leave the guild
 * half-configured.
 */
export async function writeGuildConfig(payload: {
  guildId: string;
  label?: string;
  roles: Record<string, string>;
  auditChannelId?: string;
}): Promise<void> {
  const base = process.env.APP_API_URL;
  const secret = process.env.DISCORD_SERVICE_SECRET;
  if (!base) throw new AppApiError('APP_API_URL is not set');
  if (!secret) throw new AppApiError('DISCORD_SERVICE_SECRET is not set');

  const response = await fetch(new URL('/api/discord/config', base), {
    method: 'POST',
    headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(10_000),
  });

  if (!response.ok) {
    throw new AppApiError(`POST /api/discord/config -> ${response.status}`);
  }
}
