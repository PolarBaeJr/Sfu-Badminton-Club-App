import { describe, it, expect } from 'vitest';
import { normalizeEmail, CLAIM_PRIVILEGE_COLUMNS } from '../roster-claim';

// buildRosterClaim's tests used to live here. The claim moved into SQL in 00132
// (ensure_player_for_user + claim_privilege_attribution) because it has to be
// race-safe — one row from two concurrent sign-ins, and never two people
// claiming the same roster row — and that is a single-statement guarantee only
// the database can offer. Its behaviour is verified against a real Postgres,
// not here; what is left in this file is the part that is still TypeScript.

describe('normalizeEmail', () => {
  it('folds case and trims, matching normalize_player_email_trg (00066)', () => {
    expect(normalizeEmail('  LSA139@SFU.ca ')).toBe('lsa139@sfu.ca');
  });

  it('leaves ilike wildcards alone, because the caller must use an equality filter', () => {
    // The bug this function exists because of: the lookup was
    // .ilike('email', user.email) with the address dropped in raw, and both `_`
    // and `%` are legal in a local part AND wildcards to ilike — the owner of
    // 'a_c@sfu.ca' matched the unclaimed row for 'abc@sfu.ca'. Escaping is not
    // the fix (PostgREST rewrites `*` to `%` afterwards); an equality filter,
    // which has no pattern language at all, is. So this must NOT escape: an
    // escaped string would stop matching the row it is meant to find.
    expect(normalizeEmail('a_c@sfu.ca')).toBe('a_c@sfu.ca');
    expect(normalizeEmail('a%c@sfu.ca')).toBe('a%c@sfu.ca');
  });
});

describe('CLAIM_PRIVILEGE_COLUMNS', () => {
  it('is the three columns that confer console access, and only those', () => {
    // admin_access_level tests role and is_exec; is_trainer opens the varsity
    // notes. Mirrored by claim_privilege_attribution() in 00132 — if this list
    // and that function disagree, a privilege is decided about in one place and
    // not the other.
    expect([...CLAIM_PRIVILEGE_COLUMNS]).toEqual(['role', 'is_exec', 'is_trainer']);
  });

  it('does not include the columns a claim deliberately leaves alone', () => {
    // status, membership_type and fee_exempt describe who the admin decided this
    // person is. They grant no console access and re-deriving them would make
    // the admin retype what they already entered.
    for (const column of ['status', 'membership_type', 'fee_exempt', 'first_name']) {
      expect(CLAIM_PRIVILEGE_COLUMNS).not.toContain(column);
    }
  });
});
