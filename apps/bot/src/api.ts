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

/**
 * The caller's Discord account is already connected to a club account.
 *
 * NOT an AppApiError. dispatch() renders every AppApiError as "couldn't reach
 * the club app", which would be a lie here -- the app answered, clearly, and
 * the answer was "no". Kept separate so handleLink can say what is true.
 */
export class AlreadyLinkedError extends Error {}

/**
 * The role named is one the nightly sweep controls, so it cannot be self-serve.
 *
 * Separate from AppApiError for the same reason AlreadyLinkedError is: the app
 * answered clearly and the answer was a specific, fixable "no". Rendering it as
 * "couldn't reach the club app" would send an exec looking for a network fault.
 */
export class SweepManagedRoleError extends Error {}

/**
 * The app answered 429: the caller has filed too much, too fast.
 *
 * Separate for the same reason as the two above. "Couldn't reach the club app"
 * would send a member retrying a request that is working exactly as designed,
 * and each retry pushes their next allowed attempt further out.
 */
export class RateLimitedError extends Error {}

// Deliberately short. Discord's interaction deadline is 3 seconds end to end, so
// a request that has not answered in 2.5s cannot be rendered in time anyway — and
// failing fast leaves room to reply with something useful instead of timing out
// silently, which Discord surfaces as "the application did not respond".
const TIMEOUT_MS = 2500;

async function get<T>(path: string, callerId?: string | null): Promise<T> {
  const base = process.env.APP_API_URL;
  const secret = process.env.DISCORD_SERVICE_SECRET;
  if (!base) throw new AppApiError('APP_API_URL is not set');
  if (!secret) throw new AppApiError('DISCORD_SERVICE_SECRET is not set');

  const response = await fetch(new URL(path, base), {
    headers: {
      authorization: `Bearer ${secret}`,
      // A HEADER, never a query param: ids in a URL end up in the access log.
      // Omitted entirely when there is no caller, so the app sees an absent
      // header rather than the string "null" or "undefined".
      ...(callerId ? { 'x-discord-user-id': callerId } : {}),
    },
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

async function send<T>(
  method: 'POST' | 'DELETE',
  path: string,
  body?: unknown
): Promise<T> {
  const base = process.env.APP_API_URL;
  const secret = process.env.DISCORD_SERVICE_SECRET;
  if (!base) throw new AppApiError('APP_API_URL is not set');
  if (!secret) throw new AppApiError('DISCORD_SERVICE_SECRET is not set');

  const response = await fetch(new URL(path, base), {
    method,
    headers: {
      authorization: `Bearer ${secret}`,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });

  if (!response.ok) {
    // 409 is the app telling us the role is one the nightly sweep controls.
    // Distinguished here so the command can explain the actual problem rather
    // than reporting a generic failure for a mistake with an obvious fix.
    if (response.status === 409) throw new SweepManagedRoleError('sweep-managed');
    if (response.status === 429) throw new RateLimitedError('rate-limited');
    throw new AppApiError(`${method} ${path} -> ${response.status}`);
  }

  return (await response.json()) as T;
}

export interface SelfRole {
  roleId: string;
  label: string;
  emoji: string | null;
  sortOrder: number;
}

/** The ping roles members may assign themselves in this guild. */
export function fetchSelfRoles(
  guildId: string
): Promise<{ roles: SelfRole[]; truncated: boolean }> {
  const params = new URLSearchParams({ guildId });
  return get<{ roles: SelfRole[]; truncated: boolean }>(
    `/api/discord/self-roles?${params}`
  );
}

export function addSelfRole(input: {
  guildId: string;
  roleId: string;
  label: string;
  emoji?: string | null;
  sortOrder?: number;
}): Promise<{ ok: true }> {
  return send<{ ok: true }>('POST', '/api/discord/self-roles', input);
}

export function removeSelfRole(guildId: string, roleId: string): Promise<{ ok: true }> {
  const params = new URLSearchParams({ guildId, roleId });
  return send<{ ok: true }>('DELETE', `/api/discord/self-roles?${params}`);
}

export interface DuePing {
  sessionId: string;
  channelId: string;
  // Every role to mention in this ONE message. The app groups by channel so
  // that a club-wide session matching several ping roles does not produce the
  // same announcement twice in the same place.
  roleIds: string[];
  name: string | null;
  startsAt: string;
  location: string | null;
}

/** Sessions due a ping, decided entirely by the app. */
export function fetchDuePings(guildId: string): Promise<{ pings: DuePing[] }> {
  const params = new URLSearchParams({ guildId });
  return get<{ pings: DuePing[] }>(`/api/discord/session-pings?${params}`);
}

/** Record a ping that has ALREADY been posted. Never call this beforehand. */
export function recordPing(sessionId: string, roleIds: string[]): Promise<{ ok: true }> {
  return send<{ ok: true }>('POST', '/api/discord/session-pings', { sessionId, roleIds });
}

export interface TournamentEventAction {
  kind: 'create' | 'update' | 'cancel';
  tournamentId: string;
  /** null only for a create. */
  discordEventId: string | null;
  name: string;
  /** What to SEND Discord — possibly clamped forward past a start already gone. */
  startsAt: string;
  endsAt: string;
  /** What the tournament ITSELF says. Recorded, so the change detector stays stable. */
  syncedStartsAt: string;
  syncedEndsAt: string;
  /**
   * False once Discord has started the event. Discord will not retime an event
   * in progress, so the PATCH carries name and description only — see the
   * app-side route, which is where the decision is made.
   */
  patchTimes: boolean;
  location: string | null;
  description: string;
}

/** Tournaments that owe Discord a scheduled event, or a change to one. */
export function fetchTournamentActions(guildId: string): Promise<{
  actions: TournamentEventAction[];
  skipped: { tournamentId: string; reason: string }[];
}> {
  const params = new URLSearchParams({ guildId });
  return get(`/api/discord/tournament-events?${params}`);
}

/** Record an event Discord has ALREADY accepted. Never call this beforehand. */
export function recordTournamentEvent(input: {
  tournamentId: string;
  guildId: string;
  discordEventId: string;
  name: string;
  syncedStartsAt: string;
  syncedEndsAt: string;
}): Promise<{ ok: true }> {
  return send<{ ok: true }>('POST', '/api/discord/tournament-events', input);
}

/** Forget a mapping, after the Discord event is gone. */
export function clearTournamentEvent(
  tournamentId: string,
  guildId: string
): Promise<{ ok: true }> {
  const params = new URLSearchParams({ tournamentId, guildId });
  return send<{ ok: true }>('DELETE', `/api/discord/tournament-events?${params}`);
}

export interface TournamentSummary {
  id: string;
  name: string;
  startDate: string;
  endDate: string | null;
  events: string[];
  registrationOpen: boolean;
  /** null for an unlinked caller: "we do not know", not "no". */
  eligible: boolean | null;
}

/**
 * Upcoming tournaments, annotated for THIS caller.
 *
 * The id is required rather than optional for the same reason fetchSessions's
 * is: a new call site that omitted it would silently get the anonymous view.
 */
export function fetchTournaments(
  discordUserId: string | null
): Promise<{ tournaments: TournamentSummary[]; linked: boolean }> {
  return get<{ tournaments: TournamentSummary[]; linked: boolean }>(
    '/api/discord/tournaments',
    discordUserId
  );
}

export function fetchLeaderboard(
  ladder: string,
  page: number
): Promise<LeaderboardPage> {
  const params = new URLSearchParams({ ladder, page: String(page) });
  return get<LeaderboardPage>(`/api/discord/leaderboard?${params}`);
}

export interface ClubHandle {
  handle: string;
  name: string;
}

/**
 * Every handle the ladder publishes, for the /profile picker.
 *
 * NAMES AND HANDLES ONLY. The route it calls reads the same ladder function the
 * handle lookup itself reads, so the suggestions are exactly the set a member
 * could already have found by typing — see the route for why that equivalence
 * is the privacy argument and not a coincidence.
 */
export function fetchHandles(): Promise<{ members: ClubHandle[] }> {
  return get<{ members: ClubHandle[] }>('/api/discord/handles');
}

/**
 * The schedule as THIS caller should see it.
 *
 * The id is required rather than optional so a new call site cannot quietly
 * omit it and get the unlinked view for everybody — the compiler asks. Pass
 * null only where there genuinely is no caller.
 */
export function fetchSessions(
  discordUserId: string | null
): Promise<{ sessions: SessionSummary[]; linked: boolean }> {
  return get<{ sessions: SessionSummary[]; linked: boolean }>(
    '/api/discord/sessions',
    discordUserId
  );
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
  // 409 is the app declining on purpose, not a fault: this Discord account
  // already has a link row. Distinguished from every other non-ok status so
  // the member is told to /unlink rather than told the app is down.
  if (response.status === 409) {
    throw new AlreadyLinkedError('already linked');
  }
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

// ---- ANNOUNCEMENT RELAY ----------------------------------------------------

export interface AnnouncementAction {
  kind: 'post' | 'edit' | 'retract';
  announcementId: string;
  /** For an edit or retract this is the channel the message IS in, which is not
   *  necessarily the configured one — a club that repoints the setting has not
   *  moved the messages it already posted. */
  channelId: string;
  /** null only for a post. */
  discordMessageId: string | null;
  title: string;
  body: string;
  /** announcement_type: info | warning | urgent | event. Picks the colour. */
  type: string;
  url: string | null;
}

/** Announcements that owe Discord a message, or a change to one. */
export function fetchAnnouncementActions(guildId: string): Promise<{
  actions: AnnouncementAction[];
  skipped: { announcementId: string; reason: string }[];
}> {
  const params = new URLSearchParams({ guildId });
  return get(`/api/discord/announcements?${params}`);
}

/** Record a message Discord has ALREADY accepted. Never call this beforehand. */
export function recordAnnouncementPost(input: {
  announcementId: string;
  guildId: string;
  channelId: string;
  discordMessageId: string;
  title: string;
  body: string;
  type: string;
}): Promise<{ ok: true }> {
  return send<{ ok: true }>('POST', '/api/discord/announcements', input);
}

/** Forget a mapping, after the Discord message is gone. */
export function clearAnnouncementPost(
  announcementId: string,
  guildId: string
): Promise<{ ok: true }> {
  const params = new URLSearchParams({ announcementId, guildId });
  return send<{ ok: true }>('DELETE', `/api/discord/announcements?${params}`);
}

// ---- MATCH RESULT RELAY ----------------------------------------------------

export interface MatchResultAction {
  kind: 'post' | 'edit' | 'retract';
  matchId: string;
  /** For an edit or retract this is the channel the message IS in, which is not
   *  necessarily the configured one — a club that repoints the setting has not
   *  moved the messages it already posted. */
  channelId: string;
  /** null only for a post. */
  discordMessageId: string | null;
  /** Rendered line, and the mapping's change-detection key. */
  summary: string;
  teamA: string;
  teamB: string;
  score: string;
  /** Which side won. null only on a retract, where there is nothing to render. */
  winner: 'a' | 'b' | null;
  /** singles | doubles. */
  matchType: string;
  playedAt: string | null;
}

/** Confirmed results that owe Discord a message, or a change to one. */
export function fetchMatchResultActions(guildId: string): Promise<{
  actions: MatchResultAction[];
  skipped: { matchId: string; reason: string }[];
  /** Present when the tick's read hit its cap. NOT decoration: a capped window
   *  is the one condition under which a match that should be posted, or one
   *  that should be taken down, is silently deferred to a later tick. If it is
   *  set every tick, the window is too small for the club's volume. */
  windowCapReached?: number;
}> {
  const params = new URLSearchParams({ guildId });
  return get(`/api/discord/match-results?${params}`);
}

/** Record a message Discord has ALREADY accepted. Never call this beforehand. */
export function recordMatchPost(input: {
  matchId: string;
  guildId: string;
  channelId: string;
  discordMessageId: string;
  summary: string;
}): Promise<{ ok: true }> {
  return send<{ ok: true }>('POST', '/api/discord/match-results', input);
}

/** Forget a mapping, after the Discord message is gone. */
export function clearMatchPost(matchId: string, guildId: string): Promise<{ ok: true }> {
  const params = new URLSearchParams({ matchId, guildId });
  return send<{ ok: true }>('DELETE', `/api/discord/match-results?${params}`);
}

// ---- FEEDBACK AND BUG REPORTS ----------------------------------------------

export type FeedbackKind = 'bug' | 'feedback' | 'tournament_feedback' | 'other';

/**
 * File one report. See 00172.
 *
 * `linked` comes back so the caller can warn a reporter whose Discord account
 * is not connected to a club account that a reply may not reach them. The row
 * is stored either way — an unlinked member is the one most likely to have hit
 * an onboarding bug, and turning them away would silence exactly that report.
 */
export function submitFeedback(input: {
  kind: FeedbackKind;
  /** null for a report filed by anything that is not the modal. */
  title: string | null;
  body: string;
  /** Discord CDN url of a screenshot. SIGNED AND EXPIRING — see 00173. */
  imageUrl: string | null;
  discordUserId: string | null;
  guildId: string | null;
}): Promise<{ ok: true; linked: boolean }> {
  return send<{ ok: true; linked: boolean }>('POST', '/api/discord/feedback', input);
}

// ---- FEEDBACK RELAY --------------------------------------------------------

export interface FeedbackAction {
  kind: 'post' | 'edit' | 'retract';
  /** Which table sourceId points into: a Discord-filed report, or a tournament
   *  survey response from the website. They render differently and they go to
   *  DIFFERENT configured channels; see 00173's header on why. */
  source: 'report' | 'event_feedback';
  sourceId: string;
  /** For an edit or retract this is the channel the message IS in, which is not
   *  necessarily the configured one — a club that repoints the setting has not
   *  moved the messages it already posted. */
  channelId: string;
  /** null only for a post. */
  discordMessageId: string | null;
  /** Rendered body, and the mapping's change-detection key. */
  summary: string;
  title: string;
  body: string;
  /** Whose report it is, already rendered — a mention when the reporter is
   *  linked, a plain name or a bare Discord id when they are not. */
  author: string;
  /** report: the kind. event_feedback: the tournament name. */
  context: string;
  /** 1..5, event_feedback only. */
  rating: number | null;
  /** Screenshot url, report only, and only while it still resolves. */
  imageUrl: string | null;
  createdAt: string | null;
}

/** Reports and survey comments that owe Discord a message, or a change to one. */
export function fetchFeedbackActions(guildId: string): Promise<{
  actions: FeedbackAction[];
  skipped: { sourceId: string; reason: string }[];
  /** Present when the tick's read hit its cap; see fetchMatchResultActions. */
  windowCapReached?: number;
}> {
  const params = new URLSearchParams({ guildId });
  return get(`/api/discord/feedback-relay?${params}`);
}

/** Record a message Discord has ALREADY accepted. Never call this beforehand. */
export function recordFeedbackPost(input: {
  source: 'report' | 'event_feedback';
  sourceId: string;
  guildId: string;
  channelId: string;
  discordMessageId: string;
  summary: string;
}): Promise<{ ok: true }> {
  return send<{ ok: true }>('POST', '/api/discord/feedback-relay', input);
}

/** Forget a mapping, after the Discord message is gone. */
export function clearFeedbackPost(
  source: 'report' | 'event_feedback',
  sourceId: string,
  guildId: string
): Promise<{ ok: true }> {
  const params = new URLSearchParams({ source, sourceId, guildId });
  return send<{ ok: true }>('DELETE', `/api/discord/feedback-relay?${params}`);
}

export interface ProfileLadderLine {
  elo: number;
  provisional: boolean;
  wins: number;
  losses: number;
  streak: number;
  rank: number;
}

export interface ProfilePayload {
  id: string;
  name: string;
  handle: string | null;
  avatarUrl: string | null;
  bio: string | null;
  status: string | null;
  ranked: boolean;
  doubles: ProfileLadderLine | null;
  singles: ProfileLadderLine | null;
  tournamentPoints: number | null;
  awards: { label: string; glyph?: string | null }[];
}

/** The app declining on purpose — not a fault. See fetchProfile. */
export type ProfileMiss =
  | 'not_linked'
  | 'target_unlinked'
  | 'no_such_handle'
  | 'not_found';

export type ProfileResult =
  | { profile: ProfilePayload; cardUrl: string }
  | { miss: ProfileMiss };

/**
 * A member's profile card.
 *
 * Written out rather than routed through get() for two reasons. The 404s are
 * the app declining on purpose — "you haven't linked", "no such handle" — and
 * get() turns every non-ok status into the same AppApiError, which would tell a
 * member the club app was down when they had simply mistyped a handle. And the
 * card's URL has to be built against APP_PUBLIC_URL: Discord's CDN fetches the
 * image from outside the cluster, so the in-cluster APP_API_URL it would
 * otherwise inherit is unreachable. Same split, and the same reason, as
 * mintLinkToken.
 *
 * Both Discord ids travel as HEADERS. Ids in a URL end up in the access log.
 */
export async function fetchProfile(
  callerId: string | null,
  target: { discordUserId?: string | null; handle?: string | null }
): Promise<ProfileResult> {
  const base = process.env.APP_API_URL;
  const secret = process.env.DISCORD_SERVICE_SECRET;
  const publicBase = process.env.APP_PUBLIC_URL;
  if (!base) throw new AppApiError('APP_API_URL is not set');
  if (!secret) throw new AppApiError('DISCORD_SERVICE_SECRET is not set');
  if (!publicBase) throw new AppApiError('APP_PUBLIC_URL is not set');

  const path = target.handle
    ? `/api/discord/profile?${new URLSearchParams({ handle: target.handle })}`
    : '/api/discord/profile';

  const response = await fetch(new URL(path, base), {
    headers: {
      authorization: `Bearer ${secret}`,
      ...(callerId ? { 'x-discord-user-id': callerId } : {}),
      ...(target.discordUserId ? { 'x-discord-target-id': target.discordUserId } : {}),
    },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });

  if (response.status === 404) {
    const body = (await response.json().catch(() => null)) as { error?: string } | null;
    const miss = body?.error;
    return {
      miss:
        miss === 'not_linked' ||
        miss === 'target_unlinked' ||
        miss === 'no_such_handle'
          ? miss
          : 'not_found',
    };
  }

  if (!response.ok) {
    throw new AppApiError(`GET /api/discord/profile -> ${response.status}`);
  }

  const body = (await response.json()) as { profile: ProfilePayload; cardToken: string };
  return {
    profile: body.profile,
    cardUrl: new URL(`/api/discord/card/${body.cardToken}`, publicBase).toString(),
  };
}

export interface CardFile {
  filename: string;
  contentType: string;
  bytes: Uint8Array;
}

// A rendered card is tens of kilobytes. Anything approaching this is not one,
// and buffering it would spend the rest of the interaction's budget on a body
// that is going to be discarded.
const MAX_CARD_BYTES = 2 * 1024 * 1024;

/**
 * The rendered card as BYTES, so the reply can upload it instead of linking it.
 *
 * NEVER THROWS. A timeout, an expired card token, an HTML error page from
 * something in front of the app — every one of them comes back as null, because
 * the caller's answer to null is the URL fallback and an exception would sail
 * past it into dispatch's generic "couldn't reach the club app". The whole
 * point of the fallback is that it stays reachable.
 *
 * Takes its budget rather than using TIMEOUT_MS: by the time this runs the
 * caller has already spent part of Discord's three seconds on fetchProfile, and
 * what is left still has to cover encoding and writing the multipart body.
 */
export async function fetchCard(cardUrl: string, budgetMs: number): Promise<CardFile | null> {
  try {
    const response = await fetch(cardUrl, { signal: AbortSignal.timeout(budgetMs) });
    if (!response.ok) return null;

    // A proxy error page is a 200 whose body is HTML. Uploading it would attach
    // a file Discord renders as a broken image, which reads as the card being
    // wrong rather than the card never having arrived.
    const contentType = response.headers.get('content-type') ?? '';
    if (!contentType.startsWith('image/')) return null;

    // Checked twice on purpose: the header is absent on a chunked response, so
    // it can only ever reject early, never authorise.
    const declared = Number(response.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > MAX_CARD_BYTES) return null;

    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength === 0 || bytes.byteLength > MAX_CARD_BYTES) return null;

    return { filename: 'card.png', contentType, bytes };
  } catch {
    return null;
  }
}
