// Small helpers for surfacing Supabase read errors instead of silently
// rendering wrong/empty pages when a query fails.

type SupabaseResult<T> = { data: T | null; error: { message: string } | null };

/** Throws on query error or missing data. Use when the row/rows must exist. */
export function unwrap<T>(res: SupabaseResult<T>): T {
  if (res.error) throw new Error(res.error.message);
  if (res.data === null) throw new Error('Not found');
  return res.data;
}

/** Throws only on query error; null data is a legal result (e.g. maybeSingle). */
export function unwrapMaybe<T>(res: SupabaseResult<T>): T | null {
  if (res.error) throw new Error(res.error.message);
  return res.data;
}
