// Query parameter parsing. Every parser either returns a value for the RPC or
// names the parameter it refuses, which the handler turns into
// 400 {"error":"bad_request","parameter":"<name>"}.
//
// TIMESTAMPS MUST BE UTC AND END IN `Z`. An offset or a bare date would be read
// in whatever zone the database happens to use, and its tzdata is stale after
// 2026-11-01, so the only unambiguous form is the one accepted.

export const MAX_LIMIT = 500;
export const DEFAULT_LIMIT = 100;
export const MAX_OFFSET = 100_000;
export const DEFAULT_WINDOW_DAYS = 30;
export const MAX_WINDOW_DAYS = 366;

const DAY_MS = 86_400_000;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,6})?)?Z$/;
/** data_api_player_ref's and data_api_match_ref's output: a sha256 hex digest. */
export const REF_PATTERN = /^[0-9a-f]{64}$/;

export type ParamKind =
  | { kind: 'uuid' }
  | { kind: 'timestamp' }
  | { kind: 'ref' }
  | { kind: 'enum'; values: readonly string[] }
  | { kind: 'bool' }
  | { kind: 'int'; min: number; max: number };

/**
 * Every query parameter any route accepts. Exported so the drift test can
 * check each one appears in the served documentation and in API.md.
 */
export const QUERY_PARAMS = {
  season: { kind: 'uuid' },
  since: { kind: 'timestamp' },
  until: { kind: 'timestamp' },
  player: { kind: 'ref' },
  opponent: { kind: 'ref' },
  type: { kind: 'enum', values: ['singles', 'doubles'] },
  source: { kind: 'enum', values: ['club', 'tournament'] },
  rated: { kind: 'bool' },
  status: { kind: 'enum', values: ['final', 'voided', 'all'] },
  updated_since: { kind: 'timestamp' },
  limit: { kind: 'int', min: 1, max: MAX_LIMIT },
  offset: { kind: 'int', min: 0, max: MAX_OFFSET },
  from: { kind: 'timestamp' },
  to: { kind: 'timestamp' },
} as const satisfies Record<string, ParamKind>;

export type ParamName = keyof typeof QUERY_PARAMS;
export type ParsedParams = Partial<Record<ParamName, string | number | boolean>>;

export class BadParam extends Error {
  constructor(readonly parameter: string) {
    super(`bad parameter ${parameter}`);
  }
}

function parseOne(name: ParamName, raw: string): string | number | boolean {
  const spec: ParamKind = QUERY_PARAMS[name];
  switch (spec.kind) {
    case 'uuid':
      if (!UUID_PATTERN.test(raw)) throw new BadParam(name);
      return raw.toLowerCase();
    case 'timestamp': {
      if (!TIMESTAMP_PATTERN.test(raw)) throw new BadParam(name);
      const t = Date.parse(raw);
      if (Number.isNaN(t)) throw new BadParam(name);
      return new Date(t).toISOString();
    }
    case 'ref':
      if (!REF_PATTERN.test(raw)) throw new BadParam(name);
      return raw;
    case 'enum':
      if (!spec.values.includes(raw)) throw new BadParam(name);
      return raw;
    case 'bool':
      if (raw === 'true') return true;
      if (raw === 'false') return false;
      throw new BadParam(name);
    case 'int': {
      if (!/^\d{1,7}$/.test(raw)) throw new BadParam(name);
      const n = Number(raw);
      if (n < spec.min || n > spec.max) throw new BadParam(name);
      return n;
    }
  }
}

/**
 * Parses the query string against the names a route accepts. A name the route
 * does not accept, a repeated name, or a value that does not parse is a
 * BadParam. `strict: false` ignores the query string entirely, which is what
 * the two routes that predate parameters have always done.
 */
export function parseQuery(search: URLSearchParams, allowed: readonly ParamName[], strict: boolean): ParsedParams {
  const out: ParsedParams = {};
  if (!strict) return out;
  const seen = new Set<string>();
  for (const [name, raw] of search) {
    if (!(allowed as readonly string[]).includes(name)) throw new BadParam(name);
    if (seen.has(name)) throw new BadParam(name);
    seen.add(name);
    out[name as ParamName] = parseOne(name as ParamName, raw);
  }
  if (typeof out.since === 'string' && typeof out.until === 'string' && out.until <= out.since) {
    throw new BadParam('until');
  }
  if (out.opponent !== undefined && out.player === undefined && allowed.includes('player')) {
    throw new BadParam('opponent');
  }
  return out;
}

/**
 * The schedule window. Defaults to the next 30 days from now; one bound given
 * alone gets a 30-day window on its other side; wider than 366 days, or an end
 * not after the start, is refused.
 */
export function scheduleWindow(params: ParsedParams, nowMs: number): { from: string; to: string } {
  let from = typeof params.from === 'string' ? Date.parse(params.from) : undefined;
  let to = typeof params.to === 'string' ? Date.parse(params.to) : undefined;
  if (from === undefined && to === undefined) from = nowMs;
  if (from === undefined) from = to! - DEFAULT_WINDOW_DAYS * DAY_MS;
  if (to === undefined) to = from + DEFAULT_WINDOW_DAYS * DAY_MS;
  if (to <= from) throw new BadParam('to');
  if (to - from > MAX_WINDOW_DAYS * DAY_MS) throw new BadParam('to');
  return { from: new Date(from).toISOString(), to: new Date(to).toISOString() };
}
