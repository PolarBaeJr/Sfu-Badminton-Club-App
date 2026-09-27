import { createHash } from 'node:crypto';

// A copy of packages/shared/src/utils/data-api-key.ts, which is what the console
// mints with. This service has no runtime dependencies and compiles only its own
// src/, so it cannot import that file at runtime; __tests__/key.test.ts asserts
// the two agree, so a change to the minting side fails this package's tests.

export const KEY_PATTERN = /^sfubad_[A-Za-z0-9_-]{43}$/;

/** sha256 hex of the full plaintext key, prefix included. */
export function hashKey(key: string): string {
  return createHash('sha256').update(key).digest('hex');
}
