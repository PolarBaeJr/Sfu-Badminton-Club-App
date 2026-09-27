import { createHash } from 'node:crypto';

// The data API key format and its digest. Two callers have to agree exactly:
// the console mints a key and stores this digest, and apps/data-api hashes the
// presented bearer token and asks data_api_verify_key for the same digest. If
// they diverged every key would be a 401 with nothing in any log saying why.
// apps/data-api carries its own copy (it has no runtime dependencies) and its
// test suite asserts that copy against this file.
//
// Node-only (node:crypto): imported by subpath, NOT via the barrel.

/** `sfubad_` + 43 base64url characters of 32 random bytes. */
export const DATA_API_KEY_PREFIX = 'sfubad_';

export const DATA_API_KEY_PATTERN = /^sfubad_[A-Za-z0-9_-]{43}$/;

/** sha256 hex of the full plaintext key, prefix included. */
export function hashDataApiKey(key: string): string {
  return createHash('sha256').update(key).digest('hex');
}
