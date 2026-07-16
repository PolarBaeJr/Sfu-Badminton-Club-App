import { describe, it, expect, beforeEach, vi } from 'vitest';

// Hoisted state that mocks read from. `vi.hoisted` keeps these definitions
// available before the mocked module factories run.
const state = vi.hoisted(() => ({
  user: null as { id: string } | null,
  player: null as { id: string; role: string } | null,
}));

const sentrySetUser = vi.hoisted(() => vi.fn());

vi.mock('next/headers', () => ({
  cookies: async () => ({
    getAll: () => [],
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

vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({
    from: (_table: string) => ({
      select: (_cols: string) => ({
        eq: (_col: string, _val: string) => ({
          maybeSingle: async () => ({ data: state.player }),
        }),
      }),
    }),
  }),
}));

vi.mock('@sentry/nextjs', () => ({
  setUser: sentrySetUser,
}));

// Import the module under test AFTER mocks are registered.
import { getAuthenticatedAdmin } from '../supabase-server';

beforeEach(() => {
  state.user = null;
  state.player = null;
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
});
