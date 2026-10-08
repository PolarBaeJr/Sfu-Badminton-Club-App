import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * requirePlayer is the gate EVERY member action sits behind — challenges,
 * session check-in, score submission, tournament registration. If it lets the
 * wrong account through, none of the individual actions re-check most of these
 * conditions, so the hole is everywhere at once.
 *
 * It had no tests. The player app had one test file in total.
 *
 * The module is mocked at its two seams — who is signed in, and whether a
 * lapsed member gets let back in — so these are tests of the DECISION, not of
 * Supabase.
 */

const getCurrentPlayer = vi.fn();
const reactivateLapsedMember = vi.fn();

vi.mock('../supabase-server', () => ({
  getCurrentPlayer: () => getCurrentPlayer(),
  createServiceRoleClient: () => ({}),
}));

vi.mock('../reactivate', () => ({
  reactivateLapsedMember: (p: unknown) => reactivateLapsedMember(p),
}));

// Sentry.setUser is called on every path; assert on it rather than stub it
// away, because "clear the previous request's user" is a real behaviour — this
// process is shared between requests and a stale id misattributes the next
// error to whoever was here before.
const setUser = vi.fn();
vi.mock('@sentry/nextjs', () => ({ setUser: (u: unknown) => setUser(u) }));

vi.mock('posthog-node', () => ({ PostHog: class {} }));
vi.mock('@badminton/shared/src/push/send', () => ({ sendPushToPlayers: vi.fn() }));

const { requirePlayer } = await import('../actions/_shared');

const ok = {
  id: 'p1',
  status: 'recreational',
  is_banned: false,
  active_flag: true,
  deletion_requested_at: null,
};

beforeEach(() => {
  getCurrentPlayer.mockReset();
  reactivateLapsedMember.mockReset();
  setUser.mockReset();
});

describe('requirePlayer — who is refused', () => {
  it('refuses when nobody is signed in, and clears the previous user', async () => {
    getCurrentPlayer.mockResolvedValue(null);
    await expect(requirePlayer()).rejects.toThrow('Not authenticated');
    expect(setUser).toHaveBeenCalledWith(null);
  });

  it('refuses an account still awaiting approval', async () => {
    getCurrentPlayer.mockResolvedValue({ ...ok, status: 'pending_approval' });
    await expect(requirePlayer()).rejects.toThrow('pending approval');
  });

  it('refuses a suspended account', async () => {
    getCurrentPlayer.mockResolvedValue({ ...ok, status: 'suspended' });
    await expect(requirePlayer()).rejects.toThrow('Account suspended');
  });

  // is_banned is a column of its own, NOT folded into status. A banned member
  // whose status still reads 'recreational' is exactly the case that would slip
  // through if this check were ever collapsed into the status ladder — and they
  // could then create challenges and submit rated results.
  it('refuses a banned account even when its status looks ordinary', async () => {
    getCurrentPlayer.mockResolvedValue({ ...ok, status: 'competitive', is_banned: true });
    await expect(requirePlayer()).rejects.toThrow('pending reinstatement');
  });

  it('refuses an account that asked to be deleted, rather than silently undoing it', async () => {
    getCurrentPlayer.mockResolvedValue({
      ...ok,
      active_flag: false,
      deletion_requested_at: '2026-01-01T00:00:00Z',
    });
    await expect(requirePlayer()).rejects.toThrow('scheduled for deletion');
    expect(reactivateLapsedMember).not.toHaveBeenCalled();
  });
});

describe('requirePlayer — who is let through', () => {
  it('admits an ordinary active member and tags Sentry with their id', async () => {
    getCurrentPlayer.mockResolvedValue(ok);
    const player = await requirePlayer();
    expect(player.id).toBe('p1');
    expect(setUser).toHaveBeenCalledWith({ id: 'p1' });
    // Nothing to reactivate, so nothing should be written.
    expect(reactivateLapsedMember).not.toHaveBeenCalled();
  });

  // The nightly sweep deactivates members who have not played. They are not in
  // trouble; opening the app is meant to let them straight back in.
  it('reactivates a lapsed member and returns them as active', async () => {
    getCurrentPlayer.mockResolvedValue({ ...ok, active_flag: false });
    reactivateLapsedMember.mockResolvedValue(true);

    const player = await requirePlayer();

    expect(reactivateLapsedMember).toHaveBeenCalled();
    // The caller must see the state the row NOW has, not the stale copy it was
    // fetched with — otherwise the very next check in the action sees an
    // inactive member and refuses them.
    expect(player.active_flag).toBe(true);
  });

  it('still admits a lapsed member when the reactivating write did not land', async () => {
    getCurrentPlayer.mockResolvedValue({ ...ok, active_flag: false });
    reactivateLapsedMember.mockResolvedValue(false);

    const player = await requirePlayer();

    // Refusing here would lock out a member over a failed background write they
    // cannot see or retry. They are admitted; the flag is simply not flipped.
    expect(player.id).toBe('p1');
    expect(player.active_flag).toBe(false);
  });
});

describe('requirePlayer — ordering', () => {
  // The order of the checks is load-bearing: active_flag is examined LAST,
  // precisely so that a banned or suspended member who is also deactivated is
  // refused for the real reason rather than being handed to the reactivation
  // path. Collapsing or reordering these silently re-admits banned accounts.
  it('refuses a banned member who is also deactivated, without reactivating them', async () => {
    getCurrentPlayer.mockResolvedValue({ ...ok, is_banned: true, active_flag: false });
    await expect(requirePlayer()).rejects.toThrow('pending reinstatement');
    expect(reactivateLapsedMember).not.toHaveBeenCalled();
  });

  it('refuses a suspended member who is also deactivated', async () => {
    getCurrentPlayer.mockResolvedValue({ ...ok, status: 'suspended', active_flag: false });
    await expect(requirePlayer()).rejects.toThrow('Account suspended');
    expect(reactivateLapsedMember).not.toHaveBeenCalled();
  });
});
