import { describe, it, expect } from 'vitest';
import { getAccountStanding } from '../utils/account-standing';

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

  it('does NOT refuse on active_flag — requirePlayer() does not either', () => {
    // Deliberate: mirroring the server exactly matters more than being
    // "obviously right" here. A UI that hid controls the server would have
    // allowed is its own bug. See the note in account-standing.ts.
    expect(
      getAccountStanding({ status: 'competitive', is_banned: false, active_flag: false } as never).ok,
    ).toBe(true);
    expect(getAccountStanding({ status: 'inactive', is_banned: false }).ok).toBe(true);
  });

  it('treats a signed-out visitor as unblocked', () => {
    expect(getAccountStanding(null).ok).toBe(true);
    expect(getAccountStanding(undefined).ok).toBe(true);
  });
});
