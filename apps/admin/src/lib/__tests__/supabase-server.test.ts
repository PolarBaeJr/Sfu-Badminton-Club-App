import { describe, it, expect, beforeEach, vi } from 'vitest';

// Hoisted state that mocks read from. `vi.hoisted` keeps these definitions
// available before the mocked module factories run.
const state = vi.hoisted(() => ({
  user: null as { id: string } | null,
  player: null as { id: string; role: string; status?: string; deleted_at?: string | null } | null,
}));

// `server-only` is a runtime fence that errors in client bundles; under vitest
// (Node) we just need it to resolve to an empty module.
vi.mock('server-only', () => ({}));

// `react.cache` is provided by the React server runtime and isn't available in
// the vitest Node environment; pass through to the underlying function.
vi.mock('react', async () => {
  const actual = await vi.importActual<typeof import('react')>('react');
  return { ...actual, cache: <T extends (...args: unknown[]) => unknown>(fn: T): T => fn };
});

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
          single: async () => ({ data: state.player }),
        }),
      }),
    }),
  }),
}));

// Import the module under test AFTER mocks are registered.
import { getAuthenticatedAdmin } from '../supabase-server';

beforeEach(() => {
  state.user = null;
  state.player = null;
});

describe('getAuthenticatedAdmin', () => {
  it('throws when there is no authenticated user', async () => {
    state.user = null;
    await expect(getAuthenticatedAdmin()).rejects.toThrow('Not authenticated');
  });

  it('throws when the user has no matching player row', async () => {
    state.user = { id: 'user-1' };
    state.player = null;
    await expect(getAuthenticatedAdmin()).rejects.toThrow('No player record found');
  });

  it('throws when the player is not an admin', async () => {
    state.user = { id: 'user-1' };
    state.player = { id: 'player-1', role: 'player' };
    await expect(getAuthenticatedAdmin()).rejects.toThrow('Admin access required');
  });

  it('throws when the admin is suspended (stale privilege)', async () => {
    state.user = { id: 'user-1' };
    state.player = { id: 'player-1', role: 'admin', status: 'suspended', deleted_at: null };
    await expect(getAuthenticatedAdmin()).rejects.toThrow('Admin access required');
  });

  it('throws when the admin account is soft-deleted (stale privilege)', async () => {
    state.user = { id: 'user-1' };
    state.player = { id: 'player-1', role: 'admin', status: 'recreational', deleted_at: '2026-06-01T00:00:00Z' };
    await expect(getAuthenticatedAdmin()).rejects.toThrow('Admin access required');
  });

  it('returns the player when they are an admin in good standing', async () => {
    state.user = { id: 'user-1' };
    state.player = { id: 'player-1', role: 'admin', status: 'recreational', deleted_at: null };
    const result = await getAuthenticatedAdmin();
    expect(result).toEqual(state.player);
  });
});
