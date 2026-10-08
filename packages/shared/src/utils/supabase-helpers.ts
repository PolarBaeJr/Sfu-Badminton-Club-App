// Small helpers for surfacing Supabase read errors instead of silently
// rendering wrong/empty pages when a query fails.
//
// Both throw an AppError: the message is still the query's own, and the code is
// the classifier's reading of the error (a missing column is DB-101 wherever it
// happens), else the call site's `fallback`, so the error screen names the page.
import { AppError, raise } from './app-error';
import type { ErrorCode } from './error-codes';

type SupabaseResult<T> = { data: T | null; error: { message: string } | null };

/** Throws on query error or missing data. Use when the row/rows must exist. */
export function unwrap<T>(res: SupabaseResult<T>, fallback: ErrorCode = 'DB-000'): T {
  if (res.error) throw raise(fallback, res.error);
  if (res.data === null) throw new AppError('DB-401', 'Not found');
  return res.data;
}

/** Throws only on query error; null data is a legal result (e.g. maybeSingle). */
export function unwrapMaybe<T>(res: SupabaseResult<T>, fallback: ErrorCode = 'DB-000'): T | null {
  if (res.error) throw raise(fallback, res.error);
  return res.data;
}
