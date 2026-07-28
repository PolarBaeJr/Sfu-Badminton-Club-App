import { describe, it, expect } from 'vitest';
import { buildChallengeQrUrl, isUuid } from '../challenge-qr';

const PLAYER_ID = '3f2504e0-4f89-11d3-9a0c-0305e82c3301';

// Manual staging checklist (not automatable here — the vitest env is node-only
// with no Supabase, and these assertions live in validate_challenge_creation):
//   1. Scan another member's profile QR -> /challenges/new opens with them
//      already selected -> Send Challenge -> the opponent still sees the
//      challenge as pending and must accept it. Scanning never auto-accepts.
//   2. Scan a suspended / deactivated / pending_approval member's QR -> the
//      prefill clears with a toast, and forcing the id through anyway is
//      rejected server-side ("Opponent cannot accept challenges").
//   3. Scan your own QR -> validate_challenge_creation returns
//      "Cannot challenge yourself".
//   4. The 3-active-challenge cap and the 2-matches-per-7-days rule still
//      apply and may fire during testing — that is correct behaviour and
//      surfaces through the existing error toast.

describe('isUuid', () => {
  it('accepts a canonical uuid', () => {
    expect(isUuid(PLAYER_ID)).toBe(true);
  });

  it('is case-insensitive', () => {
    expect(isUuid(PLAYER_ID.toUpperCase())).toBe(true);
  });

  it('rejects non-uuid values', () => {
    expect(isUuid('not-a-uuid')).toBe(false);
    expect(isUuid('')).toBe(false);
    expect(isUuid(undefined)).toBe(false);
    expect(isUuid(null)).toBe(false);
    // Right length, wrong shape (no dashes).
    expect(isUuid('3f2504e04f8911d39a0c0305e82c3301')).toBe(false);
    // Trailing junk must not slip past the anchors.
    expect(isUuid(`${PLAYER_ID}'; DROP TABLE players;--`)).toBe(false);
  });
});

describe('buildChallengeQrUrl', () => {
  it('builds the prefilled challenge url', () => {
    expect(buildChallengeQrUrl('https://play.example.com', PLAYER_ID)).toBe(
      `https://play.example.com/challenges/new?opponent=${PLAYER_ID}`
    );
  });

  it('strips trailing slashes from the base url', () => {
    expect(buildChallengeQrUrl('https://play.example.com/', PLAYER_ID)).toBe(
      `https://play.example.com/challenges/new?opponent=${PLAYER_ID}`
    );
    expect(buildChallengeQrUrl('https://play.example.com///', PLAYER_ID)).toBe(
      `https://play.example.com/challenges/new?opponent=${PLAYER_ID}`
    );
  });

  it('returns null when the base url env var is missing', () => {
    expect(buildChallengeQrUrl(undefined, PLAYER_ID)).toBeNull();
    expect(buildChallengeQrUrl(null, PLAYER_ID)).toBeNull();
    expect(buildChallengeQrUrl('', PLAYER_ID)).toBeNull();
    // A base of only slashes collapses to empty and is treated as unset.
    expect(buildChallengeQrUrl('/', PLAYER_ID)).toBeNull();
  });

  it('returns null for a non-uuid playerId', () => {
    expect(buildChallengeQrUrl('https://play.example.com', 'not-a-uuid')).toBeNull();
    expect(buildChallengeQrUrl('https://play.example.com', '')).toBeNull();
    expect(
      buildChallengeQrUrl('https://play.example.com', `${PLAYER_ID}&opponent=other`)
    ).toBeNull();
  });
});
