import { describe, it, expect } from 'vitest';
import { tokenFromCheckinScan, REQUIRE_SCAN_TO_CHECK_IN } from '../checkin-scan';

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

describe('REQUIRE_SCAN_TO_CHECK_IN', () => {
  it('ships as supplement, not replacement', () => {
    // Guards the default rather than the mechanism: flipping this changes what
    // attendance means, so the change should be deliberate enough to also
    // update the test that says so.
    expect(REQUIRE_SCAN_TO_CHECK_IN).toBe(false);
  });
});
