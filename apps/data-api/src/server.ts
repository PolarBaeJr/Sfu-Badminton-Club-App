import type { IncomingMessage, ServerResponse } from 'node:http';
import { isIP } from 'node:net';
import { KeyVerifier, type VerifiedKey } from './auth.js';
import { DOCS_CSP, DOCS_HTML } from './docs-page.js';
import {
  BadParam,
  DEFAULT_LIMIT,
  parseQuery,
  REF_PATTERN,
  scheduleWindow,
  type ParamName,
  type ParsedParams,
} from './params.js';
import { TokenBuckets } from './rate-limit.js';
import type { DataApiScope } from './scopes.js';
import { UpstreamError, type Upstream } from './upstream.js';

export { QUERY_PARAMS } from './params.js';

// The request handler. Everything it needs is passed in, so tests drive it with
// a mocked upstream and a hand-moved clock rather than a spawned process.
//
// ORDER OF CHECKS: route (404), the public docs page (served here, GET and HEAD
// only, 405 otherwise), method (405), key (401, or 429 from the per-address
// failed-auth bucket), per-key rate (429), scope (403), query parameters (400),
// path ref and id format (404), database. A caller learns nothing about keys
// from a route that does not exist, and a malformed ref never costs a database
// call: the by-ref functions rehash the whole eligible roster on every call.

export interface HandlerDeps {
  upstream: Upstream;
  version: string;
  now?: () => number;
  log?: (line: string) => void;
}

type RouteName =
  | 'health'
  | 'docs'
  | 'players'
  | 'player'
  | 'player_matches'
  | 'player_vs'
  | 'player_seasons'
  | 'player_ratings'
  | 'matches'
  | 'match'
  | 'seasons'
  | 'season'
  | 'season_standings'
  | 'tournaments'
  | 'tournament'
  | 'tournament_event'
  | 'sessions'
  | 'events';

export interface RouteDef {
  name: RouteName;
  template: string;
  /** Null for the two routes that need no key. */
  scope: DataApiScope | null;
  params: readonly ParamName[];
  /** False only for the routes that predate query parameters and ignore them. */
  strict: boolean;
}

const MATCH_PARAMS: readonly ParamName[] = [
  'season', 'since', 'until', 'player', 'opponent', 'type', 'source', 'rated', 'status', 'updated_since', 'limit', 'offset',
];

/**
 * Every route the service answers. Exported for the drift test, which checks
 * each template, scope and parameter appears in the documentation.
 */
export const ROUTES: readonly RouteDef[] = [
  { name: 'health', template: '/health', scope: null, params: [], strict: false },
  { name: 'docs', template: '/documentations', scope: null, params: [], strict: false },
  { name: 'players', template: '/v1/players', scope: 'players:read', params: [], strict: false },
  { name: 'player', template: '/v1/players/:ref', scope: 'players:read', params: [], strict: false },
  {
    name: 'player_matches',
    template: '/v1/players/:ref/matches',
    scope: 'matches:read',
    // The player is the path, so `opponent` stands alone here.
    params: MATCH_PARAMS.filter((p) => p !== 'player'),
    strict: true,
  },
  { name: 'player_vs', template: '/v1/players/:ref/vs/:other_ref', scope: 'matches:read', params: ['type', 'season'], strict: true },
  { name: 'player_seasons', template: '/v1/players/:ref/seasons', scope: 'matches:read', params: [], strict: true },
  {
    name: 'player_ratings',
    template: '/v1/players/:ref/ratings',
    scope: 'ratings:history:read',
    params: ['type', 'season', 'since', 'until', 'limit', 'offset'],
    strict: true,
  },
  { name: 'matches', template: '/v1/matches', scope: 'matches:read', params: MATCH_PARAMS, strict: true },
  { name: 'match', template: '/v1/matches/:match_ref', scope: 'matches:read', params: [], strict: true },
  { name: 'seasons', template: '/v1/seasons', scope: 'seasons:read', params: [], strict: true },
  { name: 'season', template: '/v1/seasons/:id', scope: 'seasons:read', params: [], strict: true },
  { name: 'season_standings', template: '/v1/seasons/:id/standings', scope: 'seasons:read', params: [], strict: true },
  { name: 'tournaments', template: '/v1/tournaments', scope: 'tournaments:read', params: ['season'], strict: true },
  { name: 'tournament', template: '/v1/tournaments/:id', scope: 'tournaments:read', params: [], strict: true },
  {
    name: 'tournament_event',
    template: '/v1/tournaments/:id/events/:event_id',
    scope: 'tournaments:read',
    params: [],
    strict: true,
  },
  { name: 'sessions', template: '/v1/sessions', scope: 'schedule:read', params: ['from', 'to'], strict: true },
  { name: 'events', template: '/v1/events', scope: 'schedule:read', params: ['from', 'to'], strict: true },
];

interface Matched {
  def: RouteDef;
  /** Path segments named by `:name` in the template. */
  vars: Record<string, string>;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Path variables that name a player or a match: 404 unless a 64-hex digest. */
const REF_VARS = new Set(['ref', 'other_ref', 'match_ref']);
/** Path variables that name a club object by its uuid: 404 unless a uuid. */
const ID_VARS = new Set(['id', 'event_id']);

const PLAYER_FIELDS = [
  'player_ref',
  'singles_elo',
  'doubles_elo',
  'singles_provisional',
  'doubles_provisional',
  'singles_matches_played',
  'doubles_matches_played',
  'singles_wins',
  'singles_losses',
  'doubles_wins',
  'doubles_losses',
  'updated_at',
] as const;

const EVENT_FIELDS = [
  'id',
  'event_type',
  'format',
  'match_format',
  'games_per_match',
  'points_per_game',
  'max_participants',
  'seeding_method',
  'elo_multiplier',
  'placement_bonus_enabled',
  'status',
  'group_count',
  'qualifiers_per_group',
  'seeded_from_event_id',
] as const;

const DOCS_BODY = Buffer.from(DOCS_HTML, 'utf8');

const KEY_RATE = { capacity: 60, windowMs: 60_000 };
const FAILED_AUTH_RATE = { capacity: 30, windowMs: 60_000 };
const VS_RECENT = 10;

function matchRoute(pathname: string): Matched | null {
  const path = pathname === '/documentations/' ? '/documentations' : pathname;
  const segments = path.split('/');
  for (const def of ROUTES) {
    const parts = def.template.split('/');
    if (parts.length !== segments.length) continue;
    const vars: Record<string, string> = {};
    let ok = true;
    for (let i = 0; i < parts.length && ok; i++) {
      const part = parts[i]!;
      const seg = segments[i]!;
      if (part.startsWith(':')) {
        if (seg) vars[part.slice(1)] = seg;
        else ok = false;
      } else if (part !== seg) {
        ok = false;
      }
    }
    if (ok) return { def, vars };
  }
  return null;
}

/** Second precision, `Z`, as API.md prints it. PostgREST sends `+00:00` and micros. */
export function isoSeconds(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  const t = Date.parse(value);
  if (Number.isNaN(t)) return value;
  return new Date(t).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

// ---------------------------------------------------------------------------
// Shapers. Each builds its output from a fixed field list, so a column the
// database grows can never reach a consumer by accident.
// ---------------------------------------------------------------------------

type Row = Record<string, unknown>;

function orNull(value: unknown): unknown {
  return value === undefined ? null : value;
}

function num(value: unknown): number {
  return typeof value === 'number' ? value : 0;
}

function asObject(value: unknown): Row | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Row) : null;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function shapePlayer(row: Row): Row {
  const out: Row = {};
  for (const field of PLAYER_FIELDS) {
    out[field] = field === 'updated_at' ? isoSeconds(row[field]) : orNull(row[field]);
  }
  return out;
}

function shapeGames(value: unknown): Row[] {
  return asArray(value).map((g) => {
    const o = asObject(g) ?? {};
    return { game: orNull(o.game), a: orNull(o.a), b: orNull(o.b) };
  });
}

function shapeRating(value: unknown): Row | null {
  const o = asObject(value);
  return o ? { before: orNull(o.before), after: orNull(o.after), delta: orNull(o.delta) } : null;
}

function shapeSide(value: unknown): Row[] {
  return asArray(value).map((p) => {
    const o = asObject(p) ?? {};
    return {
      player_ref: orNull(o.player_ref),
      won: orNull(o.won),
      rating: shapeRating(o.rating),
      points_scored: orNull(o.points_scored),
      points_allowed: orNull(o.points_allowed),
      games_won: orNull(o.games_won),
      games_lost: orNull(o.games_lost),
    };
  });
}

function shapeRefSide(value: unknown): Row[] {
  return asArray(value).map((p) => ({ player_ref: orNull(asObject(p)?.player_ref) }));
}

function shapeSeasonRef(id: unknown, name: unknown): Row | null {
  return id ? { id, name: orNull(name) } : null;
}

function shapeWalkover(value: unknown): Row | null {
  const o = asObject(value);
  if (!o) return null;
  // Club walkovers carry a type and the forfeiting side; tournament walkovers
  // record only who advanced.
  if ('type' in o) return { type: orNull(o.type), forfeit_side: orNull(o.forfeit_side) };
  return { winner_side: orNull(o.winner_side) };
}

function shapeMatchTournament(value: unknown): Row | null {
  const o = asObject(value);
  if (!o) return null;
  return {
    id: orNull(o.id),
    event_id: orNull(o.event_id),
    event_type: orNull(o.event_type),
    round_number: orNull(o.round_number),
    round_name: orNull(o.round_name),
    phase: orNull(o.phase),
    is_third_place: orNull(o.is_third_place),
  };
}

function shapeMatch(row: Row): Row {
  const sides = asObject(row.sides) ?? {};
  return {
    match_ref: orNull(row.match_ref),
    source: orNull(row.source),
    status: orNull(row.status),
    counts_toward_stats: orNull(row.counts_toward_stats),
    played_at: isoSeconds(orNull(row.played_at)),
    updated_at: isoSeconds(orNull(row.updated_at)),
    season: shapeSeasonRef(row.season_id, row.season_name),
    type: orNull(row.discipline),
    kind: orNull(row.kind),
    rated: orNull(row.rated),
    format: orNull(row.format),
    games_per_match: orNull(row.games_per_match),
    points_per_game: orNull(row.points_per_game),
    walkover: shapeWalkover(row.walkover),
    winner_side: orNull(row.winner_side),
    score_summary: orNull(row.score_summary),
    games: shapeGames(row.games),
    sides: { a: shapeSide(sides.a), b: shapeSide(sides.b) },
    tournament: shapeMatchTournament(row.tournament),
  };
}

function shapeActiveSeason(row: Row): Row {
  return {
    id: orNull(row.id),
    name: orNull(row.name),
    term: orNull(row.term),
    year: orNull(row.year),
    start_date: orNull(row.start_date),
    end_date: orNull(row.end_date),
  };
}

function shapeSeason(row: Row): Row {
  return {
    ...shapeActiveSeason(row),
    active: orNull(row.active),
    totals: {
      club_matches: num(row.club_matches),
      tournament_matches: num(row.tournament_matches),
      players_with_matches: num(row.players_with_matches),
      sessions: num(row.sessions),
      tournaments: num(row.tournaments),
      events: num(row.events),
    },
  };
}

function shapeTournament(row: Row): Row {
  return {
    id: orNull(row.id),
    name: orNull(row.name),
    season: shapeSeasonRef(row.season_id, row.season_name),
    start_date: orNull(row.start_date),
    end_date: orNull(row.end_date),
    status: orNull(row.status),
    suspended: orNull(row.suspended),
    event_multiplier: orNull(row.event_multiplier),
    placement_bonus_enabled: orNull(row.placement_bonus_enabled),
  };
}

function shapeEvent(row: Row): Row {
  const out: Row = {};
  for (const field of EVENT_FIELDS) out[field] = orNull(row[field]);
  return out;
}

function shapeEntrant(row: Row): Row {
  return {
    players: asArray(row.player_refs).map((r) => ({ player_ref: r })),
    seed: orNull(row.seed),
    status: orNull(row.status),
    final_position: orNull(row.final_position),
    group: orNull(row.group_number),
    points: orNull(row.points),
    elo: { before: orNull(row.elo_before), after: orNull(row.elo_after), change: orNull(row.elo_change) },
    combined_elo: orNull(row.combined_elo),
  };
}

function shapeLink(value: unknown): Row | null {
  const o = asObject(value);
  return o ? { match_ref: orNull(o.match_ref), position: orNull(o.position) } : null;
}

function shapeDrawRow(row: Row): Row {
  // A withheld slot keeps its place in the bracket and loses everything that
  // would say who played it.
  const withheld = row.withheld === true;
  const sides = asObject(row.sides);
  return {
    match_ref: orNull(row.match_ref),
    round_number: orNull(row.round_number),
    round_name: orNull(row.round_name),
    phase: orNull(row.phase),
    bracket_position: orNull(row.bracket_position),
    match_number: orNull(row.match_number),
    is_bye: orNull(row.is_bye),
    is_third_place: orNull(row.is_third_place),
    scheduled_time: isoSeconds(orNull(row.scheduled_time)),
    status: orNull(row.status),
    winner_to: shapeLink(row.winner_to),
    loser_to: shapeLink(row.loser_to),
    withheld,
    sides: withheld || !sides ? null : { a: shapeRefSide(sides.a), b: shapeRefSide(sides.b) },
    winner_side: withheld ? null : orNull(row.winner_side),
    games: withheld ? null : shapeGames(row.games),
  };
}

function shapeSession(row: Row): Row {
  return {
    id: orNull(row.id),
    name: orNull(row.name),
    season: shapeSeasonRef(row.season_id, row.season_name),
    date: orNull(row.date),
    starts_at: isoSeconds(orNull(row.starts_at)),
    ends_at: isoSeconds(orNull(row.ends_at)),
    location: orNull(row.location),
    status: orNull(row.status),
    track: orNull(row.track),
    require_scan_to_check_in: orNull(row.require_scan_to_check_in),
    counts: { rsvp_going: num(row.rsvp_going), attended: num(row.attended) },
  };
}

function shapeClubEvent(row: Row): Row {
  return {
    id: orNull(row.id),
    title: orNull(row.title),
    kind: orNull(row.kind),
    location: orNull(row.location),
    starts_at: isoSeconds(orNull(row.starts_at)),
    ends_at: isoSeconds(orNull(row.ends_at)),
    status: orNull(row.status),
    cancelled_at: isoSeconds(orNull(row.cancelled_at)),
    capacity: orNull(row.capacity),
    cost_cents: orNull(row.cost_cents),
    signup_opens_at: isoSeconds(orNull(row.signup_opens_at)),
    signup_closes_at: isoSeconds(orNull(row.signup_closes_at)),
    counts: { signups: num(row.signups) },
  };
}

function shapeHistory(row: Row): Row {
  return {
    at: isoSeconds(orNull(row.at)),
    type: orNull(row.discipline),
    kind: orNull(row.kind),
    source: orNull(row.source),
    match_ref: orNull(row.match_ref),
    before: orNull(row.before),
    after: orNull(row.after),
    delta: orNull(row.delta),
  };
}

interface WinLoss {
  matches: number;
  wins: number;
  losses: number;
}

function winLoss(row?: Row): WinLoss {
  return { matches: num(row?.matches), wins: num(row?.wins), losses: num(row?.losses) };
}

function seasonRecord(row?: Row): Row {
  return {
    ...winLoss(row),
    games_won: num(row?.games_won),
    games_lost: num(row?.games_lost),
    points_scored: num(row?.points_scored),
    points_allowed: num(row?.points_allowed),
  };
}

function isPrivate(ip: string): boolean {
  const v4 = ip.startsWith('::ffff:') ? ip.slice(7) : ip;
  if (isIP(v4) === 4) {
    const [a, b] = v4.split('.').map(Number) as [number, number];
    return a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
  }
  const lower = ip.toLowerCase();
  return lower === '::1' || lower.startsWith('fc') || lower.startsWith('fd') || lower.startsWith('fe80');
}

/**
 * The address the failed-auth bucket is keyed on. Behind the edge the socket
 * peer is the proxy, which would make the bucket one global bucket, so when the
 * peer is a private address X-Forwarded-For is walked from the right and the
 * first public address is taken: everything to its right was appended by our
 * own hops, everything to its left is client-supplied. A public peer (nothing
 * in front of us) is used as-is and its header is ignored.
 */
export function clientIp(req: IncomingMessage): string {
  const peer = req.socket.remoteAddress ?? 'unknown';
  if (!isPrivate(peer)) return peer;
  const xff = req.headers['x-forwarded-for'];
  const list = (Array.isArray(xff) ? xff.join(',') : (xff ?? '')).split(',').map((s) => s.trim()).filter(Boolean);
  for (let i = list.length - 1; i >= 0; i--) {
    const ip = list[i]!;
    if (isIP(ip) && !isPrivate(ip)) return ip;
  }
  return peer;
}

export function createHandler(deps: HandlerDeps) {
  const now = deps.now ?? Date.now;
  const log = deps.log ?? ((line: string) => process.stdout.write(line + '\n'));
  const verifier = new KeyVerifier(deps.upstream, now);
  const keyBuckets = new TokenBuckets(KEY_RATE.capacity, KEY_RATE.windowMs, 1000, now);
  const failBuckets = new TokenBuckets(FAILED_AUTH_RATE.capacity, FAILED_AUTH_RATE.windowMs, 10_000, now);
  const rpc = (fn: string, args: Record<string, unknown>) => deps.upstream.rpc(fn, args) as Promise<Row[]>;

  function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
    const payload = JSON.stringify(body);
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Content-Length': String(Buffer.byteLength(payload)),
      ...headers,
    });
    res.end(payload);
  }

  // Static and public, so it is cacheable, unlike every JSON response. Node
  // drops the body of a HEAD response by itself.
  function sendDocs(res: ServerResponse): void {
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'public, max-age=300',
      'Content-Security-Policy': DOCS_CSP,
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'Content-Length': String(DOCS_BODY.length),
    });
    res.end(DOCS_BODY);
  }

  function ok(res: ServerResponse, body: unknown): number {
    send(res, 200, body);
    return 200;
  }

  function notFound(res: ServerResponse): number {
    send(res, 404, { error: 'not_found' });
    return 404;
  }

  // ONE body and ONE header set for all five 401 cases, so nothing about the
  // response says which of missing, malformed, unknown, expired or revoked it was.
  function unauthorized(res: ServerResponse): number {
    send(res, 401, { error: 'unauthorized' }, { 'WWW-Authenticate': 'Bearer' });
    return 401;
  }

  function rateLimited(res: ServerResponse, retryAfter: number): number {
    send(res, 429, { error: 'rate_limited' }, { 'Retry-After': String(retryAfter) });
    return 429;
  }

  async function authenticate(req: IncomingMessage, res: ServerResponse): Promise<VerifiedKey | number> {
    const ip = clientIp(req);
    const inspected = verifier.inspect(req.headers.authorization);
    let key: VerifiedKey | null;
    if (inspected.kind === 'malformed') {
      key = null;
    } else if (inspected.kind === 'cached') {
      key = inspected.value;
    } else {
      // Only a lookup that would reach the database is gated by the failed-auth
      // bucket, so a valid cached key never pays for somebody else's guessing.
      const gate = failBuckets.check(ip);
      if (!gate.ok) return rateLimited(res, gate.retryAfter);
      key = await verifier.verify(inspected.hash);
    }
    if (!key) {
      failBuckets.take(ip);
      return unauthorized(res);
    }
    return key;
  }

  function pageOf(params: ParsedParams): { limit: number; offset: number } {
    return {
      limit: typeof params.limit === 'number' ? params.limit : DEFAULT_LIMIT,
      offset: typeof params.offset === 'number' ? params.offset : 0,
    };
  }

  // The database is asked for limit+1 rows, so a page knows whether another
  // follows without a count query.
  function paged(rows: Row[], limit: number, offset: number) {
    const more = rows.length > limit;
    const kept = more ? rows.slice(0, limit) : rows;
    return { kept, envelope: { count: kept.length, limit, offset, next_offset: more ? offset + limit : null } };
  }

  const MATCH_ARGS: [ParamName, string][] = [
    ['season', 'p_season'],
    ['since', 'p_since'],
    ['until', 'p_until'],
    ['player', 'p_player_ref'],
    ['opponent', 'p_opponent_ref'],
    ['type', 'p_type'],
    ['source', 'p_source'],
    ['rated', 'p_rated'],
    ['status', 'p_status'],
    ['updated_since', 'p_updated_since'],
  ];

  function filterArgs(params: ParsedParams, map: readonly [ParamName, string][]): Record<string, unknown> {
    const args: Record<string, unknown> = {};
    for (const [name, arg] of map) if (params[name] !== undefined) args[arg] = params[name];
    return args;
  }

  async function published(consumerId: string, ref: string): Promise<boolean> {
    const rows = await rpc('data_api_player_published', { p_consumer_id: consumerId, p_player_ref: ref });
    return rows[0]?.published === true;
  }

  /** The season block of /v1/players. A failure here degrades to null, never 503. */
  async function activeSeason(consumerId: string): Promise<Row | null> {
    try {
      const rows = await rpc('data_api_active_season', { p_consumer_id: consumerId });
      return rows[0] ? shapeActiveSeason(rows[0]) : null;
    } catch (err) {
      if (!(err instanceof UpstreamError)) throw err;
      log(JSON.stringify({ level: 'warn', msg: 'season_unavailable', fn: err.fn, upstream_status: err.status }));
      return null;
    }
  }

  async function serve(
    res: ServerResponse,
    name: RouteName,
    v: Record<string, string>,
    params: ParsedParams,
    consumerId: string,
    generatedAt: unknown,
  ): Promise<number> {
    const c = { p_consumer_id: consumerId };

    switch (name) {
      case 'players': {
        const rows = await rpc('data_api_players', c);
        const players = rows.map(shapePlayer);
        const season = await activeSeason(consumerId);
        return ok(res, { season, generated_at: generatedAt, count: players.length, players });
      }

      case 'player': {
        const rows = await rpc('data_api_player_by_ref', { ...c, p_player_ref: v.ref });
        return rows[0] ? ok(res, shapePlayer(rows[0])) : notFound(res);
      }

      case 'matches':
      case 'player_matches': {
        const own = name === 'player_matches';
        if (own && !(await published(consumerId, v.ref!))) return notFound(res);
        const { limit, offset } = pageOf(params);
        const rows = await rpc('data_api_matches', {
          ...c,
          ...filterArgs(params, MATCH_ARGS),
          ...(own ? { p_player_ref: v.ref } : {}),
          p_limit: limit + 1,
          p_offset: offset,
        });
        const { kept, envelope } = paged(rows, limit, offset);
        return ok(res, {
          generated_at: generatedAt,
          ...(own ? { player_ref: v.ref } : {}),
          ...envelope,
          matches: kept.map(shapeMatch),
        });
      }

      case 'match': {
        const rows = await rpc('data_api_match_by_ref', { ...c, p_match_ref: v.match_ref });
        return rows[0] ? ok(res, { generated_at: generatedAt, match: shapeMatch(rows[0]) }) : notFound(res);
      }

      case 'player_vs': {
        if (v.ref === v.other_ref) return notFound(res);
        if (!(await published(consumerId, v.ref!))) return notFound(res);
        if (!(await published(consumerId, v.other_ref!))) return notFound(res);
        const filters = filterArgs(params, [
          ['type', 'p_type'],
          ['season', 'p_season'],
        ]);
        const totals = await rpc('data_api_head_to_head', {
          ...c,
          p_player_ref: v.ref,
          p_other_ref: v.other_ref,
          ...filters,
        });
        const find = (relation: string, discipline: string) =>
          totals.find((r) => r.relation === relation && r.discipline === discipline);
        const recent = await rpc('data_api_matches', {
          ...c,
          ...filters,
          p_player_ref: v.ref,
          p_opponent_ref: v.other_ref,
          p_limit: VS_RECENT,
        });
        return ok(res, {
          generated_at: generatedAt,
          player_ref: v.ref,
          other_ref: v.other_ref,
          as_opponents: { singles: winLoss(find('opponents', 'singles')), doubles: winLoss(find('opponents', 'doubles')) },
          as_partners: { doubles: winLoss(find('partners', 'doubles')) },
          recent: recent.slice(0, VS_RECENT).map(shapeMatch),
        });
      }

      case 'player_seasons': {
        if (!(await published(consumerId, v.ref!))) return notFound(res);
        const rows = await rpc('data_api_player_seasons', { ...c, p_player_ref: v.ref });
        // One row per (season, discipline) played, plus one with a null
        // discipline for a season with only a final rating. Grouped here.
        const order: string[] = [];
        const bySeason = new Map<string, Row[]>();
        for (const row of rows) {
          const id = String(row.season_id);
          if (!bySeason.has(id)) {
            bySeason.set(id, []);
            order.push(id);
          }
          bySeason.get(id)!.push(row);
        }
        const seasons = order.map((id) => {
          const group = bySeason.get(id)!;
          const first = group[0]!;
          const final = group.find((r) => r.final_singles_elo != null || r.final_doubles_elo != null);
          return {
            season: {
              id: first.season_id,
              name: orNull(first.season_name),
              active: orNull(first.active),
              start_date: orNull(first.start_date),
            },
            singles: seasonRecord(group.find((r) => r.discipline === 'singles')),
            doubles: seasonRecord(group.find((r) => r.discipline === 'doubles')),
            final_rating: final
              ? { singles: orNull(final.final_singles_elo), doubles: orNull(final.final_doubles_elo) }
              : null,
          };
        });
        return ok(res, { generated_at: generatedAt, player_ref: v.ref, count: seasons.length, seasons });
      }

      case 'player_ratings': {
        if (!(await published(consumerId, v.ref!))) return notFound(res);
        const { limit, offset } = pageOf(params);
        const rows = await rpc('data_api_rating_history', {
          ...c,
          p_player_ref: v.ref,
          ...filterArgs(params, [
            ['type', 'p_type'],
            ['season', 'p_season'],
            ['since', 'p_since'],
            ['until', 'p_until'],
          ]),
          p_limit: limit + 1,
          p_offset: offset,
        });
        const { kept, envelope } = paged(rows, limit, offset);
        return ok(res, { generated_at: generatedAt, player_ref: v.ref, ...envelope, history: kept.map(shapeHistory) });
      }

      case 'seasons': {
        const rows = await rpc('data_api_seasons', c);
        return ok(res, { generated_at: generatedAt, count: rows.length, seasons: rows.map(shapeSeason) });
      }

      case 'season': {
        const rows = await rpc('data_api_seasons', { ...c, p_season_id: v.id });
        return rows[0] ? ok(res, { generated_at: generatedAt, season: shapeSeason(rows[0]) }) : notFound(res);
      }

      case 'season_standings': {
        const seasons = await rpc('data_api_seasons', { ...c, p_season_id: v.id });
        const season = seasons[0];
        if (!season) return notFound(res);
        const rows = await rpc('data_api_season_standings', { ...c, p_season_id: v.id });
        return ok(res, {
          generated_at: generatedAt,
          season: { id: season.id, name: orNull(season.name), active: orNull(season.active) },
          source: season.active === true ? 'live' : 'archived',
          count: rows.length,
          standings: rows.map((r) => ({
            player_ref: orNull(r.player_ref),
            singles_elo: orNull(r.singles_elo),
            doubles_elo: orNull(r.doubles_elo),
            singles_rank: orNull(r.singles_rank),
            doubles_rank: orNull(r.doubles_rank),
            record: winLoss(r),
          })),
        });
      }

      case 'tournaments': {
        const rows = await rpc('data_api_tournaments', { ...c, ...filterArgs(params, [['season', 'p_season']]) });
        return ok(res, { generated_at: generatedAt, count: rows.length, tournaments: rows.map(shapeTournament) });
      }

      case 'tournament': {
        const rows = await rpc('data_api_tournaments', { ...c, p_tournament_id: v.id });
        if (!rows[0]) return notFound(res);
        const events = await rpc('data_api_tournament_events', { ...c, p_tournament_id: v.id });
        const entrants = await rpc('data_api_tournament_entrants', { ...c, p_tournament_id: v.id });
        return ok(res, {
          generated_at: generatedAt,
          tournament: {
            ...shapeTournament(rows[0]),
            events: events.map((e) => ({
              ...shapeEvent(e),
              entrants: entrants.filter((x) => x.event_id === e.id).map(shapeEntrant),
            })),
          },
        });
      }

      case 'tournament_event': {
        // The event list is the tournament's visibility check as well: a draft
        // tournament or a hidden season returns no events, so the event 404s.
        const events = await rpc('data_api_tournament_events', { ...c, p_tournament_id: v.id });
        const event = events.find((e) => e.id === v.event_id);
        if (!event) return notFound(res);
        const draw = await rpc('data_api_tournament_draw', { ...c, p_event_id: v.event_id });
        return ok(res, {
          generated_at: generatedAt,
          tournament_id: v.id,
          event: shapeEvent(event),
          count: draw.length,
          draw: draw.map(shapeDrawRow),
        });
      }

      case 'sessions':
      case 'events': {
        const window = scheduleWindow(params, now());
        const sessions = name === 'sessions';
        const rows = await rpc(sessions ? 'data_api_sessions' : 'data_api_club_events', {
          ...c,
          p_from: window.from,
          p_to: window.to,
        });
        return ok(res, {
          generated_at: generatedAt,
          from: isoSeconds(window.from),
          to: isoSeconds(window.to),
          count: rows.length,
          [sessions ? 'sessions' : 'events']: rows.map(sessions ? shapeSession : shapeClubEvent),
        });
      }

      case 'health':
      case 'docs':
        // Both are answered before authentication.
        return notFound(res);
    }
  }

  async function route(req: IncomingMessage, res: ServerResponse, ctx: { path: string; keyId?: string }): Promise<number> {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const matched = matchRoute(url.pathname);
    if (!matched) return notFound(res);
    const { def } = matched;
    ctx.path = def.template;
    if (def.name === 'docs') {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        send(res, 405, { error: 'method_not_allowed' }, { Allow: 'GET, HEAD' });
        return 405;
      }
      sendDocs(res);
      return 200;
    }
    if (req.method !== 'GET') {
      send(res, 405, { error: 'method_not_allowed' }, { Allow: 'GET' });
      return 405;
    }
    if (def.name === 'health') {
      send(res, 200, { ok: true, version: deps.version });
      return 200;
    }

    const auth = await authenticate(req, res);
    if (typeof auth === 'number') return auth;
    ctx.keyId = auth.keyId.slice(0, 8);

    const limit = keyBuckets.take(auth.keyId);
    if (!limit.ok) return rateLimited(res, limit.retryAfter);

    if (def.scope && !auth.scopes.includes(def.scope)) {
      send(res, 403, { error: 'forbidden', detail: `this key does not carry ${def.scope}` });
      return 403;
    }

    let params: ParsedParams;
    try {
      params = parseQuery(url.searchParams, def.params, def.strict);
      if (def.name === 'sessions' || def.name === 'events') scheduleWindow(params, now());
    } catch (err) {
      if (!(err instanceof BadParam)) throw err;
      send(res, 400, { error: 'bad_request', parameter: err.parameter });
      return 400;
    }

    // A ref or id that cannot exist is a 404 without asking the database.
    const vars: Record<string, string> = {};
    for (const [key, value] of Object.entries(matched.vars)) {
      if (REF_VARS.has(key) && !REF_PATTERN.test(value)) return notFound(res);
      if (ID_VARS.has(key) && !UUID_PATTERN.test(value)) return notFound(res);
      vars[key] = ID_VARS.has(key) ? value.toLowerCase() : value;
    }

    const generatedAt = isoSeconds(new Date(now()).toISOString());
    return serve(res, def.name, vars, params, auth.consumerId, generatedAt);
  }

  return async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const started = now();
    // Logged by route TEMPLATE, never by path, and the query string is never
    // logged: a path carries player and match refs, and either could carry a
    // key somebody pasted into a URL.
    const ctx: { path: string; keyId?: string } = { path: '(unmatched)' };
    let status: number;
    try {
      status = await route(req, res, ctx);
    } catch (err) {
      if (err instanceof UpstreamError) {
        log(JSON.stringify({ level: 'error', msg: 'upstream_failed', fn: err.fn, upstream_status: err.status }));
      } else {
        log(JSON.stringify({ level: 'error', msg: 'handler_failed', error: err instanceof Error ? err.name : 'unknown' }));
      }
      if (!res.headersSent) send(res, 503, { error: 'unavailable' });
      status = 503;
    }
    const line: Record<string, unknown> = {
      method: req.method,
      path: ctx.path,
      status,
      ms: now() - started,
    };
    if (ctx.keyId) line.key = ctx.keyId;
    log(JSON.stringify(line));
  };
}
