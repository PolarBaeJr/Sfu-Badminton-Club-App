import { describe, it, expect } from 'vitest';
import { tokenFromCheckinScan, checkInAffordances, requiresScanToCheckIn } from '../checkin-scan';

// A member at the door points the camera at whatever is in front of them. This
// function is the only thing standing between "any QR code in the world" and a
// server action, so the interesting cases are the ones that must NOT resolve.

const TOKEN = 'a'.repeat(48);
const OTHER = '0123456789abcdef'.repeat(3); // 48 hex, a different token

describe('tokenFromCheckinScan — codes that are ours', () => {
  it('reads the absolute URL the admin console encodes', () => {
    expect(tokenFromCheckinScan(`https://sfubadminton.com/checkin/${TOKEN}`)).toBe(TOKEN);
  });

  it('reads the same path relative', () => {
    expect(tokenFromCheckinScan(`/checkin/${OTHER}`)).toBe(OTHER);
  });

  it('reads it through a basePath prefix', () => {
    expect(tokenFromCheckinScan(`https://example.org/player/checkin/${TOKEN}`)).toBe(TOKEN);
  });

  it('tolerates a trailing slash, a query and a hash', () => {
    expect(tokenFromCheckinScan(`https://example.org/checkin/${TOKEN}/`)).toBe(TOKEN);
    expect(tokenFromCheckinScan(`https://example.org/checkin/${TOKEN}?utm=poster`)).toBe(TOKEN);
    expect(tokenFromCheckinScan(`https://example.org/checkin/${TOKEN}#x`)).toBe(TOKEN);
  });

  it('accepts a bare token, in case a code is ever plain text', () => {
    expect(tokenFromCheckinScan(TOKEN)).toBe(TOKEN);
  });

  it('trims surrounding whitespace', () => {
    expect(tokenFromCheckinScan(`  https://example.org/checkin/${TOKEN}  `)).toBe(TOKEN);
  });

  it('reads the ?checkin= form the sign-in round-trip leaves behind', () => {
    expect(tokenFromCheckinScan(`https://example.org/login?checkin=${TOKEN}`)).toBe(TOKEN);
  });

  it('does not care which host the code names', () => {
    // Staging, production and the domain being retired all encode real codes;
    // the token is resolved server-side, so the host proves nothing either way.
    expect(tokenFromCheckinScan(`https://badminton.polardev.org/checkin/${OTHER}`)).toBe(OTHER);
  });
});

describe('tokenFromCheckinScan — codes that are not', () => {
  it('refuses a TOURNAMENT check-in code', () => {
    // Same 48-hex shape, different table. Anything that hunted the string for
    // hex would hand this to checkInWithToken and get "Invalid check-in code"
    // for a code that is genuinely a check-in code.
    expect(tokenFromCheckinScan(`https://example.org/tournaments/checkin?token=${TOKEN}`)).toBeNull();
  });

  it('refuses a player profile QR', () => {
    expect(
      tokenFromCheckinScan('https://example.org/challenges/new?opponent=3f2504e0-4f89-41d3-9a0c-0305e82c3301'),
    ).toBeNull();
  });

  it('refuses an unrelated QR code entirely', () => {
    expect(tokenFromCheckinScan('https://www.instagram.com/sfubadminton')).toBeNull();
    expect(tokenFromCheckinScan('WIFI:S:GymGuest;T:WPA;P:hunter2;;')).toBeNull();
    expect(tokenFromCheckinScan('just some text')).toBeNull();
  });

  it('refuses an empty or whitespace-only scan', () => {
    expect(tokenFromCheckinScan('')).toBeNull();
    expect(tokenFromCheckinScan('   ')).toBeNull();
  });

  it('refuses a wrong-shaped token in the right-shaped path', () => {
    expect(tokenFromCheckinScan('https://example.org/checkin/not-a-token')).toBeNull();
    expect(tokenFromCheckinScan(`https://example.org/checkin/${'a'.repeat(47)}`)).toBeNull();
    expect(tokenFromCheckinScan(`https://example.org/checkin/${'A'.repeat(48)}`)).toBeNull();
  });

  it('refuses rather than throws on a malformed percent-escape', () => {
    expect(tokenFromCheckinScan('https://example.org/checkin/%zz')).toBeNull();
  });

  it('refuses a deeper path that merely contains the token', () => {
    expect(tokenFromCheckinScan(`https://example.org/a/b/checkin/${TOKEN}`)).toBeNull();
  });
});

describe('requiresScanToCheckIn', () => {
  // The policy used to be a build-time constant. It is now a column, applied by
  // hand, which means the app runs for a while against a database that has
  // never heard of it — so what "absent" means is the load-bearing case here,
  // not an edge case.

  it('reads an unset session as permissive', () => {
    expect(requiresScanToCheckIn({ require_scan_to_check_in: false })).toBe(false);
  });

  it('reads a session marked strict as strict', () => {
    expect(requiresScanToCheckIn({ require_scan_to_check_in: true })).toBe(true);
  });

  it('reads a MISSING column as permissive, never as strict', () => {
    // Before migration 00116 lands, select('*') returns rows without the field
    // at all. Defaulting the other way would lock an entire club out of
    // check-in on the strength of a deploy that ran ahead of its SQL.
    expect(requiresScanToCheckIn({})).toBe(false);
    expect(requiresScanToCheckIn({ require_scan_to_check_in: null })).toBe(false);
    expect(requiresScanToCheckIn(null)).toBe(false);
    expect(requiresScanToCheckIn(undefined)).toBe(false);
  });
});

describe('checkInAffordances', () => {
  it('offers both routes by default, which is what every session ships with', () => {
    expect(checkInAffordances(false)).toEqual({
      directOnCard: true,
      directInDialog: true,
      cameraFallback: 'direct',
    });
  });

  // THE ONE THAT MATTERS. Scanning is required and the camera never starts —
  // denied, absent, or an insecure origin; QrScanner renders its own message
  // and never tells the parent which. If ANY direct affordance survives that
  // moment, one tap on "Deny" buys permanent check-in-from-home and the setting
  // is a fiction. Asserted as a whole object rather than field by field, so a
  // fourth affordance added later fails this test until somebody decides what
  // it does under the strict policy.
  it('leaves NO direct check-in route when scanning is required', () => {
    const strict = checkInAffordances(true);
    expect(strict).toEqual({
      directOnCard: false,
      directInDialog: false,
      cameraFallback: 'printed-code',
    });
    // Said again in the form the requirement is written in: nothing on this
    // screen is a way in that skips the code.
    expect(Object.values(strict).some((v) => v === true)).toBe(false);
    expect(strict.cameraFallback).not.toBe('direct');
  });
});
