import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * A member's own photo and video consent (00255). Pinned at its seams: the
 * session client's RPC and the player read. The action must work for a member
 * in any standing, and must take no player id from the client.
 */

const rpc = vi.fn();
const getCurrentPlayer = vi.fn();

vi.mock('../supabase-server', () => ({
  createServerSupabaseClient: async () => ({ rpc: (...args: unknown[]) => rpc(...args) }),
  createServiceRoleClient: vi.fn(),
  getCurrentPlayer: () => getCurrentPlayer(),
}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@sentry/nextjs', () => ({ captureException: vi.fn(), setUser: vi.fn() }));
vi.mock('posthog-node', () => ({ PostHog: class {} }));
vi.mock('@badminton/shared/src/push/send', () => ({ sendPushToPlayers: vi.fn() }));
vi.mock('../reactivate', () => ({ reactivateLapsedMember: vi.fn() }));

const { getMyMediaConsent, setMyMediaConsent } = await import('../actions/media-consent');

const suspended = {
  id: 'p1',
  status: 'suspended',
  is_banned: false,
  active_flag: true,
  media_consent: true,
  media_consent_changed_at: '2026-09-25T20:00:00Z',
};

beforeEach(() => {
  rpc.mockReset();
  rpc.mockResolvedValue({ data: [{ media_consent: true, media_consent_changed_at: '2026-09-25T20:00:00Z' }], error: null });
  getCurrentPlayer.mockReset();
  getCurrentPlayer.mockResolvedValue(suspended);
});

describe('setMyMediaConsent', () => {
  it('calls set_my_media_consent with the submitted boolean and nothing else', async () => {
    const res = await setMyMediaConsent({ media_consent: true });
    expect(res).toEqual({ ok: true, data: { consent: true, changedAt: '2026-09-25T20:00:00Z' } });
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith('set_my_media_consent', { p_consent: true });
  });

  it('ignores a player id the client sends', async () => {
    await setMyMediaConsent({ media_consent: false, player_id: 'someone-else' });
    expect(rpc).toHaveBeenCalledWith('set_my_media_consent', { p_consent: false });
  });

  it('refuses a non-boolean before the database', async () => {
    for (const bad of [{ media_consent: 'true' }, { media_consent: 1 }, {}, null]) {
      expect((await setMyMediaConsent(bad)).ok).toBe(false);
    }
    expect(rpc).not.toHaveBeenCalled();
  });

  it('works for a member who is not in good standing', async () => {
    getCurrentPlayer.mockResolvedValue({ ...suspended, is_banned: true, status: 'pending_approval' });
    expect((await setMyMediaConsent({ media_consent: false })).ok).toBe(true);
  });

  it('refuses a signed-out caller', async () => {
    getCurrentPlayer.mockResolvedValue(null);
    expect((await setMyMediaConsent({ media_consent: true })).ok).toBe(false);
    expect(rpc).not.toHaveBeenCalled();
  });

  it('reports a database error as a failure', async () => {
    rpc.mockResolvedValue({ data: null, error: { message: 'boom' } });
    expect((await setMyMediaConsent({ media_consent: true })).ok).toBe(false);
  });
});

describe('getMyMediaConsent', () => {
  it('reads the value off the row of the caller', async () => {
    expect(await getMyMediaConsent()).toEqual({
      ok: true,
      data: { consent: true, changedAt: '2026-09-25T20:00:00Z' },
    });
  });
});

describe('the source', () => {
  const source = readFileSync(join(__dirname, '../actions/media-consent.ts'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '');

  it('never uses requirePlayer, which refuses a member not in good standing', () => {
    expect(source).not.toContain('requirePlayer');
  });

  it('takes no player id argument', () => {
    expect(source).not.toMatch(/p_player_id|playerId/);
    expect(source).toMatch(/export async function setMyMediaConsent\(input: unknown\)/);
  });
});
