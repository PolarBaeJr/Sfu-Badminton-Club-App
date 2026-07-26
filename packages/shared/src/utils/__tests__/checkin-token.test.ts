import { describe, it, expect } from 'vitest';
import { CHECKIN_TOKEN_REGEX } from '../constants';

// CHECKIN_TOKEN_REGEX is the contract between the admin generator
// (randomBytes(24).toString('hex')) and every consumer of a scanned QR: the
// /checkin/[token] page, the login round-trip, the auth callback, post-login,
// and checkInWithToken. If it drifts, a valid code stops working or a junk
// value gets carried into a redirect — so pin the exact accepted shape here.

const hex = (n: number) => 'a'.repeat(n);

const ACCEPTED: [string, string][] = [
  ['48 lowercase hex a-f', hex(48)],
  ['48 hex digits', '0'.repeat(48)],
  ['a real randomBytes(24) value', '3f0c9b1a7e4d2856ff01a9c3b7e5d40216938a7cfe0b1d24'],
];

const REJECTED: [string, string][] = [
  ['empty string', ''],
  ['47 chars — one short', hex(47)],
  ['49 chars — one long', hex(49)],
  ['uppercase hex', 'A'.repeat(48)],
  ['mixed case', 'aA'.repeat(24)],
  ['non-hex letters', 'g'.repeat(48)],
  ['a session UUID', '3f0c9b1a-7e4d-4856-bf01-a9c3b7e5d402'],
  ['a UUID with the dashes stripped (32 chars)', '3f0c9b1a7e4d4856bf01a9c3b7e5d402'],
  ['path traversal', '../../etc/passwd'],
  ['48 hex chars with a traversal suffix', `${hex(48)}/../feed`],
  ['48 hex chars with a leading slash', `/${hex(48)}`],
  ['48 hex chars with surrounding whitespace', ` ${hex(48)} `],
  ['48 hex chars with a trailing newline', `${hex(48)}\n`],
  ['an absolute URL', `https://evil.example/${hex(48)}`],
  ['a query string appended', `${hex(48)}?next=/admin`],
];

describe('CHECKIN_TOKEN_REGEX', () => {
  it.each(ACCEPTED)('accepts %s', (_label, token) => {
    expect(CHECKIN_TOKEN_REGEX.test(token)).toBe(true);
  });

  it.each(REJECTED)('rejects %s', (_label, token) => {
    expect(CHECKIN_TOKEN_REGEX.test(token)).toBe(false);
  });

  it('is not sticky or global, so repeated .test() calls are stable', () => {
    const token = hex(48);
    expect(CHECKIN_TOKEN_REGEX.test(token)).toBe(true);
    expect(CHECKIN_TOKEN_REGEX.test(token)).toBe(true);
  });
});
