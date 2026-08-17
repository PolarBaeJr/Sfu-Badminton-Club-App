// Splitting an `.in(column, ids)` filter so the request line stays under the
// proxy's limit.
//
// PostgREST takes `.in()` as a QUERY-STRING parameter — `?id=in.(uuid,uuid,…)`
// — so the filter's size is the URL's size, and a `select` is a GET with no
// body to move it into. Kong 3.9.1 sits in front of PostgREST and refuses a
// request line over 8,192 bytes with `414 Request-URI Too Large`.
//
// MEASURED on the production request path (Cloudflare → proxy-manager → Kong →
// PostgREST), from inside the running admin container, against the same select
// list the push path uses:
//
//     215 ids → 8,047 B → reached PostgREST
//     220 ids → 8,232 B → 414
//     500 ids → 18,592 B → 520 (Cloudflare gives up before Kong answers)
//
// So the club's push stops working entirely somewhere between 215 and 220
// members — on roster size alone, with no user-visible error, because the
// caller of the failed read fails closed and withholds push from everybody
// while the in-app bell keeps working.
//
// The constants below encode that constraint rather than a number that happens
// to work today, so the chunk size moves if the limit or the id format does.

/** Kong's request-line cap. Measured, not guessed — see the probe above. */
export const REQUEST_LINE_LIMIT_BYTES = 8192;

/**
 * Bytes one id contributes to the query string. A uuid is 36 characters, all
 * of them unreserved in a query string (hex plus `-`), so none percent-encode;
 * the 37th byte is the comma separating it from the next one. Confirmed by the
 * probe's slope: (8232 − 7492) / 20 = 37, and (11192 − 8232) / 80 = 37.
 */
export const BYTES_PER_ID = 37;

/**
 * Everything in the request line that is NOT ids: the method and HTTP version,
 * the `/rest/v1/<table>` path, the `select=` column list, `in.()` itself, and
 * any other filter or `order` the call site adds.
 *
 * The measured intercept for the push query is ~92 bytes. Reserving 4,096 —
 * half the whole budget, forty-four times the observed overhead — is deliberate
 * slack: this helper is applied at a dozen call sites with select lists ranging
 * from `id` to seven columns plus embeds, and a chunk size that is only correct
 * for the shortest of them is the same latent cliff one column further out.
 */
export const RESERVED_REQUEST_BYTES = 4096;

/**
 * Ids per request: the largest n satisfying
 * `RESERVED_REQUEST_BYTES + n × BYTES_PER_ID ≤ REQUEST_LINE_LIMIT_BYTES`.
 *
 * Works out at 110, i.e. a worst-case request line of 4,166 bytes against an
 * 8,192-byte limit. `apps/admin/src/app/audit/page.tsx` reached 100 by hand and
 * shipped it; this is the same order, derived instead of chosen.
 */
export const IN_CHUNK_SIZE = Math.floor(
  (REQUEST_LINE_LIMIT_BYTES - RESERVED_REQUEST_BYTES) / BYTES_PER_ID,
);

/** Split ids into batches small enough for one request line each. */
export function chunkIds<T>(ids: readonly T[], size: number = IN_CHUNK_SIZE): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < ids.length; i += size) out.push(ids.slice(i, i + size));
  return out;
}

// Structurally a PostgrestError, without importing one: `code` has to survive
// the round trip because callers switch on it — private-notes.ts treats
// PGRST205 as "this table does not exist yet" and renders normally.
export type ChunkQueryError = {
  message: string;
  code?: string | null;
  details?: string | null;
  hint?: string | null;
};

type ChunkResult<T> = { data: T[] | null; error: ChunkQueryError | null };

/**
 * Run one `.in()` read per chunk and concatenate the rows.
 *
 * THE ERROR IS RETURNED, NOT SWALLOWED, and that is the whole point of the
 * signature. The obvious version of this helper does `const { data } = await
 * run(batch)` and pushes `data ?? []`, which trades today's bug for a worse
 * one: a failed chunk becomes an empty array, so the caller sees a SHORT list
 * rather than a failure — 100 members silently reclassified as "did not opt
 * in", with nothing logged. The present bug at least fires one Sentry event.
 *
 * So every caller keeps the semantics it already had. `filterPushRecipients`
 * still fails closed on error; `sendPushToPlayers` still throws; the audit page
 * still tolerates a missing name. This decides none of that.
 *
 * Chunks run with bounded parallelism rather than serially, because the call
 * sites are page loads: at `IN_CHUNK_SIZE` a 1,000-row read (PostgREST's
 * `db-max-rows` on prod) is ten requests, and ten serial round-trips is a
 * visible delay for no reason. The bound keeps a large id list from turning
 * into a burst against the single Postgres this all runs on.
 */
export const CHUNK_QUERY_CONCURRENCY = 4;

export async function selectInChunks<T>(
  ids: readonly string[],
  run: (batch: string[]) => PromiseLike<ChunkResult<T>>,
): Promise<ChunkResult<T>> {
  if (ids.length === 0) return { data: [], error: null };

  const batches = chunkIds(ids);
  const rows: T[] = [];
  let firstError: ChunkQueryError | null = null;

  // Inlined rather than reusing mapWithConcurrency: this needs to keep going
  // after a failed chunk (to report the first error while still collecting a
  // deterministic result), where the push pool needs to stop.
  let cursor = 0;
  const results = new Array<ChunkResult<T>>(batches.length);
  const worker = async (): Promise<void> => {
    for (;;) {
      const index = cursor++;
      if (index >= batches.length) return;
      results[index] = await run(batches[index] as string[]);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(CHUNK_QUERY_CONCURRENCY, batches.length) }, () => worker()),
  );

  for (const res of results) {
    if (res.error && !firstError) firstError = res.error;
    for (const row of res.data ?? []) rows.push(row);
  }

  // Data is still returned alongside an error so a caller that has decided
  // partial rows are acceptable can say so explicitly, rather than the helper
  // deciding for it.
  return { data: rows, error: firstError };
}
