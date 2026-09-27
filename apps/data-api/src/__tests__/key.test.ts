import { describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { hashKey, KEY_PATTERN } from '../key.js';
// The console's minting helper (apps/admin/src/lib/actions/data-api-keys.ts
// hashes with this). If the minting side ever changes format or digest, this
// file fails rather than every key silently 401ing in production.
import {
  DATA_API_KEY_PATTERN,
  DATA_API_KEY_PREFIX,
  hashDataApiKey,
} from '../../../../packages/shared/src/utils/data-api-key.js';

describe('key hashing agrees with the console', () => {
  it('hashes exactly as the minting helper does', () => {
    for (let i = 0; i < 50; i++) {
      const key = `${DATA_API_KEY_PREFIX}${randomBytes(32).toString('base64url')}`;
      expect(KEY_PATTERN.test(key)).toBe(true);
      expect(hashKey(key)).toBe(hashDataApiKey(key));
    }
  });

  it('uses the same format pattern', () => {
    expect(KEY_PATTERN.source).toBe(DATA_API_KEY_PATTERN.source);
  });

  it('matches a fixed vector: sha256 hex of the whole plaintext, prefix included', () => {
    const key = 'sfubad_' + 'A'.repeat(43);
    // Computed independently: printf 'sfubad_AAA...' | shasum -a 256
    expect(hashKey(key)).toBe('585f5ed2f67b8bf857a9866ee4de36c6df5f4e27efdccef43df4bf0955934a89');
  });
});
