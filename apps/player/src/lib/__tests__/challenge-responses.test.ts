import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Who may accept, reject or cancel a challenge.
 *
 * These are the member-facing writes with the most ways to go wrong: the actor
 * must be IN the challenge, must not be its creator, must not have answered
 * already, and only the creator may cancel. Nothing downstream re-checks any of
 * it, and all four rules live in plain TypeScript rather than in RLS.
 *
 * Supabase is stubbed at the query-builder shape rather than mocked per call,
 * so these exercise the real decisions in the real functions.
 */

const requirePlayer = vi.fn();
const assertCurrentWaiver = vi.fn();

// The row the fake client will return for `.single()`.
let challengeRow: unknown = null;
let challengeError: { code?: string; message: string } | null = null;
const updates: Array<{ table: string; values: Record<string, unknown> }> = [];

function builder(table: string) {
  const api: Record<string, unknown> = {
    select: () => api,
    update: (values: Record<string, unknown>) => {
      updates.push({ table, values });
      return api;
    },
    insert: () => api,
    eq: () => api,
    in: () => api,
    order: () => api,
    single: async () => ({ data: challengeRow, error: challengeError }),
    maybeSingle: async () => ({ data: challengeRow, error: challengeError }),
    then: (resolve: (v: unknown) => unknown) => Promise.resolve({ data: null, error: null }).then(resolve),
  };
  return api;
}

const fakeClient = { from: (t: string) => builder(t) };

vi.mock('../actions/_shared', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('../actions/_shared');
  return {
    ...actual,
    requirePlayer: () => requirePlayer(),
    assertCurrentWaiver: (...a: unknown[]) => assertCurrentWaiver(...a),
    notifyPlayers: vi.fn(),
    trackServerEvent: vi.fn(),
  };
});

vi.mock('../supabase-server', () => ({
  createServerSupabaseClient: async () => fakeClient,
  createServiceRoleClient: () => fakeClient,
  getCurrentPlayer: vi.fn(),
}));

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@sentry/nextjs', () => ({ setUser: vi.fn(), captureException: vi.fn() }));
vi.mock('posthog-node', () => ({ PostHog: class {} }));
vi.mock('@badminton/shared/src/push/send', () => ({ sendPushToPlayers: vi.fn() }));

const { acceptChallenge, rejectChallenge, cancelChallenge } = await import('../actions/challenges');

const ME = 'me';
const THEM = 'them';

beforeEach(() => {
  requirePlayer.mockReset().mockResolvedValue({ id: ME, status: 'recreational' });
  assertCurrentWaiver.mockReset().mockResolvedValue(undefined);
  challengeRow = null;
  challengeError = null;
  updates.length = 0;
});

describe('acceptChallenge', () => {
  it('refuses to let the creator accept their own challenge', async () => {
    challengeRow = {
      created_by: ME,
      challenge_participants: [{ player_id: ME, confirmation_status: 'pending' }],
    };
    const res = await acceptChallenge('c1');
    expect(res).toEqual({ ok: false, error: 'Cannot accept your own challenge' });
    expect(updates).toHaveLength(0);
  });

  it('refuses somebody who is not in the challenge at all', async () => {
    challengeRow = {
      created_by: THEM,
      challenge_participants: [{ player_id: 'someone-else', confirmation_status: 'pending' }],
    };
    const res = await acceptChallenge('c1');
    expect(res).toEqual({ ok: false, error: 'Not a participant' });
    expect(updates).toHaveLength(0);
  });

  it('refuses a second response from someone who already answered', async () => {
    challengeRow = {
      created_by: THEM,
      challenge_participants: [{ player_id: ME, confirmation_status: 'accepted' }],
    };
    const res = await acceptChallenge('c1');
    expect(res).toEqual({ ok: false, error: 'Already responded to this challenge' });
    expect(updates).toHaveLength(0);
  });

  it('accepts for a pending participant', async () => {
    challengeRow = {
      created_by: THEM,
      challenge_participants: [{ player_id: ME, confirmation_status: 'pending' }],
    };
    const res = await acceptChallenge('c1');
    expect(res.ok).toBe(true);
    expect(updates.some((u) => u.values.confirmation_status === 'accepted')).toBe(true);
  });

  // A missing row is reported as a plain Error rather than an ExpectedError on
  // purpose: under RLS an invisible challenge looks exactly like a deleted one,
  // so this stays reportable and a row-visibility regression surfaces instead
  // of being shrugged off as "not found".
  it('reports a missing challenge rather than treating it as an ordinary refusal', async () => {
    challengeRow = null;
    challengeError = { code: 'PGRST116', message: 'no rows' };
    const res = await acceptChallenge('c1');
    expect(res.ok).toBe(false);
  });

  // PGRST116 is genuinely "no rows". Anything else — a permission failure, a
  // broken embed — must surface as itself, not be flattened into "not found"
  // on a challenge that plainly exists.
  it('surfaces a non-PGRST116 error as itself', async () => {
    challengeError = { code: '42501', message: 'permission denied for table challenges' };
    const res = await acceptChallenge('c1');
    expect(res).toEqual({ ok: false, error: 'permission denied for table challenges' });
  });

  it('is blocked by an unsigned waiver before it reads anything', async () => {
    assertCurrentWaiver.mockRejectedValue(new Error('Please accept the club\'s current legal documents before playing'));
    const res = await acceptChallenge('c1');
    expect(res.ok).toBe(false);
    expect(updates).toHaveLength(0);
  });
});

describe('rejectChallenge', () => {
  it('refuses the creator rejecting their own challenge', async () => {
    challengeRow = {
      created_by: ME,
      challenge_participants: [{ player_id: ME, confirmation_status: 'pending' }],
    };
    const res = await rejectChallenge('c1');
    expect(res).toEqual({ ok: false, error: 'Cannot reject your own challenge' });
  });

  it('rejects for a pending participant', async () => {
    challengeRow = {
      created_by: THEM,
      challenge_participants: [{ player_id: ME, confirmation_status: 'pending' }],
    };
    const res = await rejectChallenge('c1');
    expect(res.ok).toBe(true);
  });
});

describe('cancelChallenge', () => {
  it('lets only the creator cancel', async () => {
    challengeRow = { created_by: THEM, status: 'pending' };
    const res = await cancelChallenge('c1');
    expect(res).toEqual({ ok: false, error: 'Only the creator can cancel' });
  });
});
