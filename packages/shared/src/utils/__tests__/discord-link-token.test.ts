import { describe, it, expect } from 'vitest';
import { hashDiscordLinkToken, isDiscordLinkToken } from '../discord-link-token';
import { DISCORD_LINK_TOKEN_REGEX } from '../constants';

describe('hashDiscordLinkToken', () => {
  it('matches the SHA-256 of the token', async () => {
    // A known vector, not a round trip. Two independent callers depend on this
    // producing the same bytes — the minting route hashes before the insert and
    // the /link page hashes before the lookup — and if they ever disagreed the
    // only symptom would be every link failing with "expired or already used",
    // which is also what a genuinely expired token looks like.
    expect(await hashDiscordLinkToken('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'
    );
  });

  it('is hex of the right length to be stored as a token_hash', async () => {
    expect(await hashDiscordLinkToken('x')).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('isDiscordLinkToken', () => {
  it('accepts a real 32-byte hex token', () => {
    expect(isDiscordLinkToken('a'.repeat(64))).toBe(true);
  });

  it('rejects anything that could redirect somewhere else', () => {
    // This is the guard every hop of the sign-in chain calls before putting the
    // value back into a URL, so a path traversal or an absolute URL slipping
    // through is what would turn the chain into an open redirect.
    for (const bad of [
      '../../evil',
      'https://evil.example/x',
      '/feed',
      'a'.repeat(63),
      'a'.repeat(65),
      'A'.repeat(64), // uppercase: the regex is lowercase hex on purpose
      '',
      null,
      undefined,
    ]) {
      expect(isDiscordLinkToken(bad as string)).toBe(false);
    }
  });

  it('agrees with the exported regex', () => {
    expect(DISCORD_LINK_TOKEN_REGEX.test('f'.repeat(64))).toBe(true);
  });
});
