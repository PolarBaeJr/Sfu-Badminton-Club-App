import { createHash } from 'node:crypto';

// The data API key format and its digest. Two callers have to agree exactly:
// the console mints a key and stores this digest, and apps/data-api hashes the
// presented bearer token and asks data_api_verify_key for the same digest. If
// they diverged every key would be a 401 with nothing in any log saying why.
// apps/data-api is Rust and cannot import this file: it carries its own copy
// (src/key.rs) and its tests/key.rs reads the prefix and pattern off this file.
// Both sides pin the same fixed digest (here in __tests__/data-api-key.test.ts),
// so a change to either fails a test.
//
// Node-only (node:crypto): imported by subpath, NOT via the barrel.

/** `sfubad_` + 43 base64url characters of 32 random bytes. */
export const DATA_API_KEY_PREFIX = 'sfubad_';

export const DATA_API_KEY_PATTERN = /^sfubad_[A-Za-z0-9_-]{43}$/;

/** sha256 hex of the full plaintext key, prefix included. */
export function hashDataApiKey(key: string): string {
  return createHash('sha256').update(key).digest('hex');
}

/**
 * Every scope a key can carry. The SQL CHECK data_api_keys_scope_vocabulary
 * (00264) admits exactly these, the console offers exactly these, and
 * apps/data-api keeps a copy in src/scopes.rs that its tests/scopes.rs asserts
 * against this list.
 */
export const DATA_API_SCOPES = [
  'players:read',
  'matches:read',
  'ratings:history:read',
  'seasons:read',
  'tournaments:read',
  'schedule:read',
] as const;

export type DataApiScope = (typeof DATA_API_SCOPES)[number];
