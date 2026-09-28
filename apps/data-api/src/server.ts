import type { IncomingMessage, ServerResponse } from 'node:http';
import { isIP } from 'node:net';
import { KeyVerifier, type VerifiedKey } from './auth.js';
import { DOCS_CSP, DOCS_HTML } from './docs-page.js';
import { TokenBuckets } from './rate-limit.js';
import { UpstreamError, type Upstream } from './upstream.js';

// The request handler. Everything it needs is passed in, so tests drive it with
// a mocked upstream and a hand-moved clock rather than a spawned process.
//
// ORDER OF CHECKS: route (404), the public docs page (served here, GET and HEAD
// only, 405 otherwise), method (405), key (401, or 429 from the per-address
// failed-auth bucket), per-key rate (429), scope (403), ref format (404),
// database. A caller learns nothing about keys from a route that does not
// exist, and a malformed ref never costs a database call: the by-ref function
// rehashes the whole eligible roster on every call.

export interface HandlerDeps {
  upstream: Upstream;
  version: string;
  now?: () => number;
  log?: (line: string) => void;
}

type Route =
  | { name: 'health'; template: '/health' }
  | { name: 'docs'; template: '/documentations' }
  | { name: 'players'; template: '/v1/players' }
  | { name: 'player'; template: '/v1/players/:ref'; ref: string }
  | { name: 'matches'; template: '/v1/matches' };

// The ref is data_api_player_ref's output: a sha256 hex digest, passed through
// unchanged. Anything else cannot match, so it is a 404 without asking.
const REF_PATTERN = /^[0-9a-f]{64}$/;

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

const DOCS_BODY = Buffer.from(DOCS_HTML, 'utf8');

const KEY_RATE = { capacity: 60, windowMs: 60_000 };
const FAILED_AUTH_RATE = { capacity: 30, windowMs: 60_000 };

function matchRoute(pathname: string): Route | null {
  if (pathname === '/health') return { name: 'health', template: '/health' };
  if (pathname === '/documentations' || pathname === '/documentations/') {
    return { name: 'docs', template: '/documentations' };
  }
  if (pathname === '/v1/players') return { name: 'players', template: '/v1/players' };
  if (pathname === '/v1/matches') return { name: 'matches', template: '/v1/matches' };
  const m = /^\/v1\/players\/([^/]+)$/.exec(pathname);
  if (m?.[1]) return { name: 'player', template: '/v1/players/:ref', ref: m[1] };
  return null;
}

/** Second precision, `Z`, as API.md prints it. PostgREST sends `+00:00` and micros. */
export function isoSeconds(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  const t = Date.parse(value);
  if (Number.isNaN(t)) return value;
  return new Date(t).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function shapePlayer(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const field of PLAYER_FIELDS) {
    out[field] = field === 'updated_at' ? isoSeconds(row[field]) : (row[field] ?? null);
  }
  return out;
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

  async function route(req: IncomingMessage, res: ServerResponse, ctx: { path: string; keyId?: string }): Promise<number> {
    const pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
    const matched = matchRoute(pathname);
    if (!matched) {
      send(res, 404, { error: 'not_found' });
      return 404;
    }
    ctx.path = matched.template;
    if (matched.name === 'docs') {
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
    if (matched.name === 'health') {
      send(res, 200, { ok: true, version: deps.version });
      return 200;
    }

    const auth = await authenticate(req, res);
    if (typeof auth === 'number') return auth;
    ctx.keyId = auth.keyId.slice(0, 8);

    const limit = keyBuckets.take(auth.keyId);
    if (!limit.ok) return rateLimited(res, limit.retryAfter);

    const scope = matched.name === 'matches' ? 'matches:read' : 'players:read';
    if (!auth.scopes.includes(scope)) {
      send(res, 403, { error: 'forbidden', detail: `this key does not carry ${scope}` });
      return 403;
    }

    const generatedAt = isoSeconds(new Date(now()).toISOString());

    if (matched.name === 'matches') {
      // API.md: accepted, and empty until the club records rated matches.
      send(res, 200, { generated_at: generatedAt, count: 0, matches: [] });
      return 200;
    }

    if (matched.name === 'players') {
      const rows = await deps.upstream.rpc('data_api_players', { p_consumer_id: auth.consumerId });
      const players = rows.map((r) => shapePlayer(r as Record<string, unknown>));
      // `season` is null: the reader role has no path to the active season's
      // name, start_date and hidden flag together. See README, "Known gaps".
      send(res, 200, { season: null, generated_at: generatedAt, count: players.length, players });
      return 200;
    }

    if (!REF_PATTERN.test(matched.ref)) {
      send(res, 404, { error: 'not_found' });
      return 404;
    }
    const rows = await deps.upstream.rpc('data_api_player_by_ref', {
      p_consumer_id: auth.consumerId,
      p_player_ref: matched.ref,
    });
    const row = rows[0];
    if (!row) {
      send(res, 404, { error: 'not_found' });
      return 404;
    }
    send(res, 200, shapePlayer(row as Record<string, unknown>));
    return 200;
  }

  return async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const started = now();
    // Unmatched paths are logged as a placeholder, and the query string is never
    // logged: either could carry a key somebody pasted into a URL.
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
