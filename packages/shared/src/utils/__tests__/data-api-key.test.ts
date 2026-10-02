import { describe, it, expect } from 'vitest';
import {
  DATA_API_KEY_PATTERN,
  DATA_API_KEY_PREFIX,
  DATA_API_SCOPES,
  hashDataApiKey,
} from '../data-api-key';

// apps/data-api (Rust) pins the same digest in its tests/key.rs and the same
// scope list in src/scopes.rs. A change here has to land there too, or every
// key the console mints would be refused by the service.
describe('data API key', () => {
  it('hashes the whole plaintext, prefix included, as sha256 hex', () => {
    expect(hashDataApiKey(`sfubad_${'A'.repeat(43)}`)).toBe(
      '585f5ed2f67b8bf857a9866ee4de36c6df5f4e27efdccef43df4bf0955934a89',
    );
    expect(hashDataApiKey('')).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
  });

  it('keeps the prefix and pattern the service accepts', () => {
    expect(DATA_API_KEY_PREFIX).toBe('sfubad_');
    expect(DATA_API_KEY_PATTERN.source).toBe('^sfubad_[A-Za-z0-9_-]{43}$');
    expect(DATA_API_KEY_PATTERN.test(`sfubad_${'A'.repeat(43)}`)).toBe(true);
    expect(DATA_API_KEY_PATTERN.test(`sfubad_${'A'.repeat(42)}`)).toBe(false);
  });

  it('keeps the scope list the service and the SQL CHECK admit', () => {
    expect([...DATA_API_SCOPES]).toEqual([
      'players:read',
      'matches:read',
      'ratings:history:read',
      'seasons:read',
      'tournaments:read',
      'schedule:read',
    ]);
  });
});
