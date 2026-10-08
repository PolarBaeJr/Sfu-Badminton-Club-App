// PostgREST RPC calls as `data_api_reader`.
//
// Any non-2xx, any network failure, a timeout, or a body that is not a JSON
// array is an UpstreamError, and the handler answers 503. That includes a
// PostgREST 404 (PGRST202, the schema cache has not seen the function yet):
// passing that through as a 404 would tell a consumer their player does not
// exist when in fact the database is not ready.

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export class UpstreamError extends Error {
  constructor(
    readonly fn: string,
    /** HTTP status from PostgREST, or 0 when no response arrived. */
    readonly status: number,
  ) {
    super(`upstream ${fn} failed with status ${status}`);
  }
}

export interface Upstream {
  rpc(fn: string, args: Record<string, unknown>): Promise<unknown[]>;
}

export function createUpstream(opts: {
  supabaseUrl: string;
  anonKey: string;
  dbJwt: string;
  fetch: FetchLike;
  timeoutMs?: number;
}): Upstream {
  const timeoutMs = opts.timeoutMs ?? 5000;
  return {
    async rpc(fn, args) {
      let res: Response;
      try {
        res = await opts.fetch(`${opts.supabaseUrl}/rest/v1/rpc/${fn}`, {
          method: 'POST',
          headers: {
            apikey: opts.anonKey,
            Authorization: `Bearer ${opts.dbJwt}`,
            'Content-Type': 'application/json',
            Accept: 'application/json',
          },
          body: JSON.stringify(args),
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch {
        throw new UpstreamError(fn, 0);
      }
      if (!res.ok) {
        // The body is never read into a log: on some errors PostgREST echoes
        // the arguments back, and one of those is a key hash.
        await res.body?.cancel().catch(() => undefined);
        throw new UpstreamError(fn, res.status);
      }
      let body: unknown;
      try {
        body = await res.json();
      } catch {
        throw new UpstreamError(fn, res.status);
      }
      if (!Array.isArray(body)) throw new UpstreamError(fn, res.status);
      return body;
    },
  };
}
