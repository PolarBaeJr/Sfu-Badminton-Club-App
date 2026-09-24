// Which registry code a raw error deserves, read off its shape.
//
// Structural on purpose: a PostgrestError, a Postgres error from a direct
// client, a fetch TypeError and an AppError all arrive here, and none of them is
// an instance this module can import without dragging a client library into the
// edge bundle. Only ./error-codes is imported.
import { isErrorCode, type ErrorCode } from './error-codes';

const DB_CODES: Record<string, ErrorCode> = {
  '42703': 'DB-101',
  PGRST204: 'DB-101',
  '42P01': 'DB-102',
  '42883': 'DB-102',
  PGRST202: 'DB-102',
  PGRST205: 'DB-102',
  PGRST200: 'DB-103',
  '42501': 'DB-201',
  '23505': 'DB-301',
  '23503': 'DB-302',
  '23514': 'DB-303',
  '23502': 'DB-303',
  '22P02': 'DB-304',
  PGRST116: 'DB-401',
  '57014': 'DB-501',
  '40001': 'DB-502',
  '40P01': 'DB-502',
  '55P03': 'DB-502',
  '53300': 'DB-503',
  '57P01': 'DB-503',
  P0001: 'DB-601',
};

const NETWORK_FAILURE = /fetch failed|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN/;

type Shape = { code?: unknown; status?: unknown; message?: unknown; cause?: unknown };

function classifyOne(err: unknown): ErrorCode | null {
  if (typeof err !== 'object' || err === null) return null;
  const { code, status, message } = err as Shape;

  if (isErrorCode(code)) return code;
  if (typeof code === 'string') {
    const db = DB_CODES[code];
    if (db) return db;
    if (/^08[0-9A-Z]{3}$/.test(code)) return 'DB-503';
    if (NETWORK_FAILURE.test(code)) return 'NET-001';
  }

  const text = typeof message === 'string' ? message.trim() : '';
  if (text === 'Not found') return 'DB-401';
  if (NETWORK_FAILURE.test(text)) return 'NET-001';
  if (status === 502 || status === 503 || status === 504 || text === '{}') return 'NET-002';
  return null;
}

/**
 * The most specific code for `err`, or `fallback`. A specific DB or network
 * classification wins over the call site's fallback, because "column missing"
 * says more than "the fees page failed". Looks one level into `cause`.
 */
export function classifyError(err: unknown, fallback: ErrorCode): ErrorCode {
  return (
    classifyOne(err) ??
    classifyOne(typeof err === 'object' && err !== null ? (err as Shape).cause : undefined) ??
    fallback
  );
}
