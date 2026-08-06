import { describe, it, expect } from 'vitest';
import { buildRosterClaim, normalizeEmail, CLAIM_PRIVILEGE_COLUMNS } from '../roster-claim';

// This is an authorization boundary, not a convenience helper: whatever
// buildRosterClaim leaves off the update, the claimed row keeps. Every
// assertion below is written as "the claim actively SETS x" rather than "the
// claim does not mention x", because inheritance-by-omission is the bug.

describe('buildRosterClaim — privilege', () => {
  it('lands an admin roster row as an ordinary member', () => {
    // The live case: lsa139@sfu.ca is role=admin, is_exec=true, user_id=NULL.
    // Before this, signing in with that address made you an admin.
    const { update } = buildRosterClaim(
      { id: 'row-1', role: 'admin', is_exec: true, is_trainer: false },
      'user-1',
    );
    expect(update.role).toBe('player');
    expect(update.is_exec).toBe(false);
    expect(update.is_trainer).toBe(false);
  });

  it('states every privilege column even on a row that had none', () => {
    // A claim that merely omits `role` passes an "is not admin" test while
    // still inheriting whatever the row holds. Demand the values are present.
    const { update } = buildRosterClaim({ id: 'row-1', role: 'player' }, 'user-1');
    for (const column of CLAIM_PRIVILEGE_COLUMNS) {
      expect(update).toHaveProperty(column);
    }
    expect(update.role).toBe('player');
    expect(update.is_exec).toBe(false);
    expect(update.is_trainer).toBe(false);
  });

  it('strips exec and trainer, not just admin', () => {
    const { update } = buildRosterClaim(
      { id: 'row-1', role: 'player', is_exec: true, is_trainer: true },
      'user-1',
    );
    expect(update.is_exec).toBe(false);
    expect(update.is_trainer).toBe(false);
  });

  it('never lets a value arrive from the row itself', () => {
    // Guards against a future refactor that spreads the row into the update.
    const { update } = buildRosterClaim(
      { id: 'row-1', role: 'admin', is_exec: true, is_trainer: true },
      'user-1',
    );
    expect(Object.values(update)).not.toContain('admin');
    expect(update.id).toBeUndefined();
    // onboarding_completed is the only `true` a claim may write.
    expect(Object.entries(update).filter(([, v]) => v === true)).toEqual([
      ['onboarding_completed', true],
    ]);
  });
});

describe('buildRosterClaim — what gets reported', () => {
  it('reports the privileges an admin row was carrying so they can be re-granted', () => {
    const { stripped } = buildRosterClaim(
      { id: 'row-1', role: 'admin', is_exec: true, is_trainer: false },
      'user-1',
    );
    expect(stripped).toEqual({ role: 'admin', is_exec: true });
  });

  it('reports nothing for an ordinary roster row', () => {
    expect(
      buildRosterClaim({ id: 'row-1', role: 'player', is_exec: false, is_trainer: false }, 'user-1')
        .stripped,
    ).toBeNull();
    // Missing fields (a narrower select) must not invent a strip either.
    expect(buildRosterClaim({ id: 'row-1' }, 'user-1').stripped).toBeNull();
  });

  it('reports a trainer row', () => {
    expect(
      buildRosterClaim({ id: 'row-1', role: 'player', is_trainer: true }, 'user-1').stripped,
    ).toEqual({ is_trainer: true });
  });
});

describe('buildRosterClaim — identity', () => {
  it('links the login and completes onboarding', () => {
    const { update } = buildRosterClaim({ id: 'row-1' }, 'user-42');
    expect(update.user_id).toBe('user-42');
    expect(update.onboarding_completed).toBe(true);
  });

  it('supplies only what the admin could not know', () => {
    const { update } = buildRosterClaim({ id: 'row-1' }, 'user-1', {
      display_name: 'Steve',
      phone: '6041234567',
    });
    expect(update.display_name).toBe('Steve');
    expect(update.phone).toBe('6041234567');
    // The admin-entered identity stays authoritative.
    expect(update).not.toHaveProperty('email');
    expect(update).not.toHaveProperty('first_name');
    expect(update).not.toHaveProperty('last_name');
    expect(update).not.toHaveProperty('status');
  });

  it('leaves an empty display name or phone alone rather than blanking the row', () => {
    const { update } = buildRosterClaim({ id: 'row-1' }, 'user-1', { display_name: '', phone: '' });
    expect(update).not.toHaveProperty('display_name');
    expect(update).not.toHaveProperty('phone');
  });
});

describe('normalizeEmail', () => {
  it('folds case and trims, matching normalize_player_email_trg', () => {
    expect(normalizeEmail('  LSA139@SFU.ca ')).toBe('lsa139@sfu.ca');
  });

  it('leaves ilike wildcards as literal characters', () => {
    // The old lookup was .ilike('email', user.email). `_` and `%` are legal in
    // an email local part and are wildcards to ilike, so the owner of
    // 'a_c@sfu.ca' matched the unclaimed row for 'abc@sfu.ca'. Escaping cannot
    // fix it — PostgREST rewrites `*` to `%` afterwards — so the fix is an
    // equality filter, and the normalizer must not start pattern-mangling.
    expect(normalizeEmail('a_c@sfu.ca')).toBe('a_c@sfu.ca');
    expect(normalizeEmail('a%c@sfu.ca')).toBe('a%c@sfu.ca');
    expect(normalizeEmail('a*c@sfu.ca')).toBe('a*c@sfu.ca');
  });
});
