import { describe, it, expect } from 'vitest';
import { getAccountStanding, isSelfReactivatable } from '../utils/account-standing';

// These cases are copied from requirePlayer() in
// apps/player/src/lib/actions/_shared.ts. If that gate changes, one of these
// should fail — that is the point of the file.
describe('getAccountStanding', () => {
  it('passes a member in good standing', () => {
    expect(getAccountStanding({ status: 'competitive', is_banned: false }).ok).toBe(true);
    expect(getAccountStanding({ status: 'recreational', is_banned: false }).ok).toBe(true);
  });

  it('refuses a pending_approval account', () => {
    const s = getAccountStanding({ status: 'pending_approval', is_banned: false });
    expect(s.ok).toBe(false);
    expect(s.block).toBe('pending_approval');
    expect(s.reason).toBeTruthy();
    expect(s.detail).toBeTruthy();
  });

  it('refuses a suspended account', () => {
    const s = getAccountStanding({ status: 'suspended', is_banned: false });
    expect(s.ok).toBe(false);
    expect(s.block).toBe('suspended');
  });

  it('refuses a banned account whose status is otherwise fine', () => {
    // The live case that started this: is_banned is its own column and is not
    // mirrored into status, so a banned member reads as 'competitive'.
    const s = getAccountStanding({ status: 'competitive', is_banned: true });
    expect(s.ok).toBe(false);
    expect(s.block).toBe('banned');
  });

  it('reports the status block before the ban when both apply', () => {
    expect(getAccountStanding({ status: 'suspended', is_banned: true }).block).toBe('suspended');
  });

  it('does NOT refuse a LAPSED member — requirePlayer() reactivates them', () => {
    // Still mirroring the server exactly, and the direction matters: a lapsed
    // member is not refused by requirePlayer(), they are put back on the roster
    // and allowed through. Blocking them here would hide controls the server
    // permits, which is the one way this module must never drift.
    expect(
      getAccountStanding({ status: 'competitive', is_banned: false, active_flag: false }).ok,
    ).toBe(true);
    expect(getAccountStanding({ status: 'inactive', is_banned: false }).ok).toBe(true);
  });

  it('refuses a deactivated account that asked to be deleted', () => {
    // The only residue once pending/suspended/banned have been handled: the
    // deletion request is the one thing signing in must not undo.
    const s = getAccountStanding({
      status: 'competitive',
      is_banned: false,
      active_flag: false,
      deletion_requested_at: '2026-08-01T00:00:00Z',
    });
    expect(s.ok).toBe(false);
    expect(s.block).toBe('deletion_pending');
    expect(s.reason).toBeTruthy();
    expect(s.detail).toBeTruthy();
  });

  it('reports the earlier block when a deactivated account is also suspended', () => {
    expect(
      getAccountStanding({ status: 'suspended', is_banned: false, active_flag: false }).block,
    ).toBe('suspended');
    expect(
      getAccountStanding({ status: 'competitive', is_banned: true, active_flag: false }).block,
    ).toBe('banned');
  });

  it('treats a signed-out visitor as unblocked', () => {
    expect(getAccountStanding(null).ok).toBe(true);
    expect(getAccountStanding(undefined).ok).toBe(true);
  });
});

// The predicate that decides whether signing in undoes a deactivation. Three
// writers clear active_flag and only ONE of them may be undone this way; every
// row shape below is one of those writers.
describe('isSelfReactivatable', () => {
  it('accepts the nightly job\'s lapsed member — the only self-service case', () => {
    expect(
      isSelfReactivatable({ active_flag: false, status: 'competitive', is_banned: false, deletion_requested_at: null }),
    ).toBe(true);
    expect(
      isSelfReactivatable({ active_flag: false, status: 'recreational', is_banned: false, deletion_requested_at: null }),
    ).toBe(true);
  });

  it('refuses a member an admin removed (removePlayer writes both columns)', () => {
    expect(
      isSelfReactivatable({ active_flag: false, status: 'suspended', is_banned: false, deletion_requested_at: null }),
    ).toBe(false);
  });

  it('refuses a member who asked to be deleted (deleteMyAccount)', () => {
    // Silently un-deleting on sign-in would be worse than refusing: the member
    // has an explicit restoreMyAccount for exactly this.
    expect(
      isSelfReactivatable({
        active_flag: false,
        status: 'competitive',
        is_banned: false,
        deletion_requested_at: '2026-08-01T00:00:00Z',
      }),
    ).toBe(false);
  });

  it('refuses a banned member, whatever their status says', () => {
    // is_banned is never mirrored into status, so a banned member reads as
    // 'competitive' — the same column independence that caused the original bug.
    expect(
      isSelfReactivatable({ active_flag: false, status: 'competitive', is_banned: true, deletion_requested_at: null }),
    ).toBe(false);
  });

  it('refuses an account still waiting for approval', () => {
    expect(
      isSelfReactivatable({ active_flag: false, status: 'pending_approval', is_banned: false }),
    ).toBe(false);
  });

  it('is false for an account that is not deactivated at all', () => {
    // Nothing to reactivate — answering true would invite a pointless write on
    // every request through requirePlayer().
    expect(isSelfReactivatable({ active_flag: true, status: 'competitive' })).toBe(false);
    expect(isSelfReactivatable({ status: 'competitive' })).toBe(false);
    expect(isSelfReactivatable(null)).toBe(false);
    expect(isSelfReactivatable(undefined)).toBe(false);
  });

  it('reads a narrowed select as "not banned, not deleting", like isInGoodStanding', () => {
    expect(isSelfReactivatable({ active_flag: false, status: 'competitive' })).toBe(true);
  });
});
