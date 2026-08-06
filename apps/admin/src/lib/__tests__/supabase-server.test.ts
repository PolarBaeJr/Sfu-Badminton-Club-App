import { describe, it, expect, beforeEach, vi } from 'vitest';

// Hoisted state that mocks read from. `vi.hoisted` keeps these definitions
// available before the mocked module factories run.
const state = vi.hoisted(() => ({
  user: null as { id: string } | null,
  player: null as { id: string; role: string } | null,
  // Admin-enrolled passkeys for this player. >0 arms the gate, so the caller
  // must present a verified cookie. Members'-app passkeys are excluded by the
  // query itself (enrolled_via = 'admin'), which is why this is a count of
  // admin credentials rather than of all of them.
  adminPasskeyCount: 0,
}));

const sentrySetUser = vi.hoisted(() => vi.fn());

vi.mock('next/headers', () => ({
  cookies: async () => ({
    getAll: () => [],
    get: () => undefined,
    set: () => {},
  }),
}));

vi.mock('@supabase/ssr', () => ({
  createServerClient: () => ({
    auth: {
      getUser: async () => ({ data: { user: state.user } }),
    },
  }),
}));

// A chainable, awaitable stub. Two different call sites share it: the player
// lookup ends in .maybeSingle(), while the passkey gate chains .eq() twice
// (player_id AND enrolled_via) and awaits the builder directly for its count.
// A stub that only models one shape lets a real second filter throw at runtime
// — which is exactly how this suite went red when the gate learned to narrow
// on enrolled_via.
vi.mock('@supabase/supabase-js', () => {
  const chain = (): Record<string, unknown> => {
    const self: Record<string, unknown> = {
      eq: () => self,
      maybeSingle: async () => ({ data: state.player }),
      // Thenable: `await supabase.from(...).select(...).eq(...).eq(...)`
      then: (resolve: (v: { count: number }) => unknown) =>
        resolve({ count: state.adminPasskeyCount }),
    };
    return self;
  };
  return {
    createClient: () => ({
      from: (_table: string) => ({ select: (_cols: string, _opts?: unknown) => chain() }),
    }),
  };
});

vi.mock('@sentry/nextjs', () => ({
  setUser: sentrySetUser,
}));

// Import the module under test AFTER mocks are registered.
import { getAuthenticatedAdmin } from '../supabase-server';

beforeEach(() => {
  state.user = null;
  state.player = null;
  state.adminPasskeyCount = 0;
  sentrySetUser.mockClear();
});

describe('getAuthenticatedAdmin', () => {
  it('throws when there is no authenticated user', async () => {
    state.user = null;
    await expect(getAuthenticatedAdmin()).rejects.toThrow('Not authenticated');
    // Failure paths clear any stale Sentry user context.
    expect(sentrySetUser).toHaveBeenCalledWith(null);
  });

  it('throws when the user has no matching player row', async () => {
    state.user = { id: 'user-1' };
    state.player = null;
    await expect(getAuthenticatedAdmin()).rejects.toThrow('No player record found');
    expect(sentrySetUser).toHaveBeenCalledWith(null);
  });

  it('throws when the player is not an admin', async () => {
    state.user = { id: 'user-1' };
    state.player = { id: 'player-1', role: 'player' };
    await expect(getAuthenticatedAdmin()).rejects.toThrow('Admin access required');
    expect(sentrySetUser).toHaveBeenCalledWith(null);
  });

  it('returns the player and tags Sentry when the player is an admin', async () => {
    state.user = { id: 'user-1' };
    state.player = { id: 'player-1', role: 'admin' };
    const result = await getAuthenticatedAdmin();
    expect(result).toEqual(state.player);
    expect(sentrySetUser).toHaveBeenCalledWith({ id: 'player-1' });
  });

  // The passkey gate broke twice in one day: once because the SQL counted any
  // passkey, and again because this server-side check duplicated that decision
  // and was not narrowed alongside it. Both times an exec lost the console with
  // nothing failing in CI, so the two states are pinned here.
  it('lets an admin with no admin-enrolled passkey through (grace period)', async () => {
    state.user = { id: 'user-1' };
    state.player = { id: 'player-1', role: 'admin' };
    state.adminPasskeyCount = 0;
    await expect(getAuthenticatedAdmin()).resolves.toEqual(state.player);
  });

  it('requires verification once an admin-enrolled passkey exists', async () => {
    state.user = { id: 'user-1' };
    state.player = { id: 'player-1', role: 'admin' };
    state.adminPasskeyCount = 1;
    // No verified cookie is set by the next/headers mock, so the gate must bite.
    await expect(getAuthenticatedAdmin()).rejects.toThrow('Passkey verification required');
    expect(sentrySetUser).toHaveBeenCalledWith(null);
  });
});
