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
