import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  CONSOLE_PASSKEY_GRACE_DAYS,
  consolePasskeyGrace,
  graceDaysText,
  parseGraceGate,
} from '../passkey/grace';

const DAY_MS = 86_400_000;
const START = '2026-09-01T00:00:00.000Z';
const at = (days: number) => Date.parse(START) + days * DAY_MS;

describe('consolePasskeyGrace', () => {
  it('is 14 days', () => {
    expect(CONSOLE_PASSKEY_GRACE_DAYS).toBe(14);
  });
  it('has 14 days left on day 0', () => {
    expect(consolePasskeyGrace(START, at(0))).toMatchObject({ expired: false, daysLeft: 14 });
  });
  it('has 1 day left half a day before the end', () => {
    expect(consolePasskeyGrace(START, at(13.5))).toMatchObject({ expired: false, daysLeft: 1 });
  });
  it('has ended at exactly 14 days, and after', () => {
    expect(consolePasskeyGrace(START, at(14))).toMatchObject({ expired: true, daysLeft: 0 });
    expect(consolePasskeyGrace(START, at(40))).toMatchObject({ expired: true, daysLeft: 0 });
  });
  it('ends 14 days after the start', () => {
    expect(consolePasskeyGrace(START, at(0))?.endsAt.toISOString()).toBe('2026-09-15T00:00:00.000Z');
  });
  it('is null for an unreadable start', () => {
    expect(consolePasskeyGrace('not a date', at(0))).toBeNull();
  });
});

describe('parseGraceGate', () => {
  it('reads the RPC answer', () => {
    expect(parseGraceGate({ has_console_passkey: false, grace_started_at: START })).toEqual({
      hasConsolePasskey: false,
      graceStartedAt: START,
    });
    expect(parseGraceGate({ has_console_passkey: true, grace_started_at: null })).toEqual({
      hasConsolePasskey: true,
      graceStartedAt: null,
    });
  });
  it('refuses anything else', () => {
    expect(parseGraceGate(null)).toBeNull();
    expect(parseGraceGate('yes')).toBeNull();
    expect(parseGraceGate([])).toBeNull();
    expect(parseGraceGate({ has_console_passkey: 'false', grace_started_at: null })).toBeNull();
    expect(parseGraceGate({ has_console_passkey: false, grace_started_at: 5 })).toBeNull();
  });
});

describe('graceDaysText', () => {
  it('says day or days', () => {
    expect(graceDaysText(1)).toBe('1 day');
    expect(graceDaysText(0)).toBe('0 days');
    expect(graceDaysText(14)).toBe('14 days');
  });
});

// The middleware is edge code no test can run, so its shape is pinned as text,
// comments stripped.
describe('the middleware passkey gate', () => {
  const src = readFileSync(join(__dirname, '..', '..', 'middleware.ts'), 'utf8')
    .split('\n')
    .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
    .join('\n');

  it('asks console_passkey_grace_start, not has_passkeys', () => {
    expect(src).toContain("rpc('console_passkey_grace_start')");
    expect(src).not.toContain("rpc('has_passkeys'");
  });

  it('refuses a password-only session before looking at the window', () => {
    const password = src.indexOf('isPasswordOnlySession(aal');
    const expiry = src.indexOf('standing.expired');
    expect(password).toBeGreaterThan(-1);
    expect(expiry).toBeGreaterThan(password);
  });

  it('answers an API call with 403 JSON and a page with /passkey-required', () => {
    expect(src).toContain("pathname.startsWith('/api/')");
    expect(src).toContain('{ status: 403 }');
    expect(src).toContain("url.pathname = '/passkey-required'");
    expect(src).toContain("pathname !== '/passkey-required'");
  });
});
