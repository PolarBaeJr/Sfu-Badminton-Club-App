import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Who may accept, reject or cancel a challenge — and what happens when two
 * people answer at once.
 *
 * THE RULES MOVED (00183). They used to live in plain TypeScript in
 * challenges.ts: read the participant list, check four things, write, then
 * recompute the aggregate status from the list read BEFORE the write. That last
 * step is audit F-008 — two partners accepting a doubles challenge in the same
 * second each saw the other still pending, so the challenge stayed
 * 'partially_confirmed' with everybody accepted and nothing ever recomputed it.
 *
 * So the fake below is no longer a query-builder shape. It is a small model of
 * respond_to_challenge: one participant list, answered one call at a time (the
 * real function holds the challenge row FOR UPDATE, which is exactly what makes
 * "one at a time" true), with the aggregate recomputed from the list AFTER the
 * write. Two things are being tested against it — that every refusal still
 * reaches the member as the sentence it used to, and that the recompute is
 * order-independent, which is the whole point of the migration.
 */

const requirePlayer = vi.fn();
const assertCurrentWaiver = vi.fn();

type Participant = { player_id: string; confirmation_status: string };

// The state respond_to_challenge would be looking at.
let challenge: { created_by: string; status: string; participants: Participant[] } | null = null;
// Set to make the RPC itself fail, as a transport or permission error would.
let rpcError: { message: string } | null = null;
const updates: Array<{ table: string; values: Record<string, unknown> }> = [];

/** A faithful model of 00183's respond_to_challenge, refusal reasons included. */
function respondToChallenge(playerId: string, response: 'accepted' | 'rejected') {
  if (!challenge) return { ok: false, reason: 'not_found' };
  if (challenge.created_by === playerId) return { ok: false, reason: 'own_challenge' };
  if (!['proposed', 'partially_confirmed'].includes(challenge.status)) {
    return { ok: false, reason: 'not_open', status: challenge.status };
  }
  const mine = challenge.participants.find((p) => p.player_id === playerId);
  if (!mine) return { ok: false, reason: 'not_participant' };
  if (mine.confirmation_status !== 'pending') return { ok: false, reason: 'already_responded' };

  mine.confirmation_status = response;
  updates.push({ table: 'challenge_participants', values: { confirmation_status: response } });

  // Read back from the rows as they NOW stand — the fix.
  challenge.status = response === 'rejected'
    ? 'rejected'
    : challenge.participants.some((p) => p.confirmation_status === 'pending')
      ? 'partially_confirmed'
      : 'accepted';
  updates.push({ table: 'challenges', values: { status: challenge.status } });

  return { ok: true, status: challenge.status, created_by: challenge.created_by };
}

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
    is: () => api,
    order: () => api,
    single: async () => ({
      data: challenge ? { ...challenge, challenge_participants: challenge.participants } : null,
      error: challenge ? null : { code: 'PGRST116', message: 'no rows' },
    }),
    maybeSingle: async () => ({ data: challenge, error: null }),
    // cancelChallenge asks for the affected rows, so a bare await has to look
    // like one row landing rather than like nothing matching.
    then: (resolve: (v: unknown) => unknown) =>
      Promise.resolve({ data: [{ id: 'c1' }], error: null }).then(resolve),
  };
  return api;
}

let currentActor = 'me';

const fakeClient = {
  from: (t: string) => builder(t),
  rpc: async (name: string, args: Record<string, unknown>) => {
    if (rpcError) return { data: null, error: rpcError };
    if (name === 'respond_to_challenge') {
      return { data: respondToChallenge(currentActor, args.p_response as 'accepted' | 'rejected'), error: null };
    }
    return { data: null, error: null };
  },
};

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

/** Run an action as somebody other than the default actor. */
async function as<T>(playerId: string, fn: () => Promise<T>): Promise<T> {
  requirePlayer.mockResolvedValue({ id: playerId, status: 'recreational' });
  currentActor = playerId;
  try {
    return await fn();
  } finally {
    requirePlayer.mockResolvedValue({ id: ME, status: 'recreational' });
    currentActor = ME;
  }
}

beforeEach(() => {
  requirePlayer.mockReset().mockResolvedValue({ id: ME, status: 'recreational' });
  assertCurrentWaiver.mockReset().mockResolvedValue(undefined);
  challenge = null;
  rpcError = null;
  currentActor = ME;
  updates.length = 0;
});

describe('acceptChallenge', () => {
  it('refuses to let the creator accept their own challenge', async () => {
    challenge = { created_by: ME, status: 'proposed', participants: [{ player_id: ME, confirmation_status: 'pending' }] };
    const res = await acceptChallenge('c1');
    expect(res).toEqual({ ok: false, error: 'Cannot accept your own challenge' });
    expect(updates).toHaveLength(0);
  });

  it('refuses somebody who is not in the challenge at all', async () => {
    challenge = { created_by: THEM, status: 'proposed', participants: [{ player_id: 'someone-else', confirmation_status: 'pending' }] };
    const res = await acceptChallenge('c1');
    expect(res).toEqual({ ok: false, error: 'Not a participant' });
    expect(updates).toHaveLength(0);
  });

  it('refuses a second response from someone who already answered', async () => {
    challenge = { created_by: THEM, status: 'partially_confirmed', participants: [{ player_id: ME, confirmation_status: 'accepted' }] };
    const res = await acceptChallenge('c1');
    expect(res).toEqual({ ok: false, error: 'Already responded to this challenge' });
    expect(updates).toHaveLength(0);
  });

  // Cancelled, expired, or ended by somebody else's rejection. The status is
  // read under the row lock, so a cancel racing an accept resolves one way.
  it('refuses a challenge that is no longer open', async () => {
    challenge = { created_by: THEM, status: 'cancelled', participants: [{ player_id: ME, confirmation_status: 'pending' }] };
    const res = await acceptChallenge('c1');
    expect(res).toEqual({ ok: false, error: 'This challenge is no longer open' });
    expect(updates).toHaveLength(0);
  });

  it('accepts for a pending participant', async () => {
    challenge = { created_by: THEM, status: 'proposed', participants: [{ player_id: ME, confirmation_status: 'pending' }] };
    const res = await acceptChallenge('c1');
    expect(res.ok).toBe(true);
    expect(updates.some((u) => u.values.confirmation_status === 'accepted')).toBe(true);
  });

  // A missing row is reported as a plain Error rather than an ExpectedError on
  // purpose: under RLS an invisible challenge looks exactly like a deleted one,
  // so this stays reportable and a row-visibility regression surfaces instead
  // of being shrugged off as "not found".
  it('reports a missing challenge rather than treating it as an ordinary refusal', async () => {
    challenge = null;
    const res = await acceptChallenge('c1');
    expect(res).toEqual({ ok: false, error: 'Challenge not found' });
  });

  // An RPC-level failure — a permission error, a broken connection — must
  // surface as itself rather than be flattened into one of the refusals above.
  it('surfaces an RPC error as itself', async () => {
    rpcError = { message: 'permission denied for function respond_to_challenge' };
    const res = await acceptChallenge('c1');
    expect(res).toEqual({ ok: false, error: 'permission denied for function respond_to_challenge' });
  });

  it('is blocked by an unsigned waiver before it writes anything', async () => {
    assertCurrentWaiver.mockRejectedValue(new Error('Please accept the club\'s current legal documents before playing'));
    const res = await acceptChallenge('c1');
    expect(res.ok).toBe(false);
    expect(updates).toHaveLength(0);
  });
});

/**
 * Audit F-008. This is the regression the migration exists for: the last accept
 * to land must leave the challenge 'accepted', whichever order the two arrive
 * in and however close together they are. The old code recomputed from a
 * snapshot taken before its own write, so BOTH concluded the other was still
 * pending and the challenge stranded at 'partially_confirmed'.
 */
describe('concurrent accepts (F-008)', () => {
  const doubles = () => ({
    created_by: 'creator',
    status: 'proposed',
    participants: [
      { player_id: 'creator', confirmation_status: 'accepted' },
      { player_id: 'p2', confirmation_status: 'pending' },
      { player_id: 'p3', confirmation_status: 'pending' },
    ],
  });

  it('lands on accepted once the last participant answers', async () => {
    challenge = doubles();
    await as('p2', () => acceptChallenge('c1'));
    expect(challenge!.status).toBe('partially_confirmed');
    await as('p3', () => acceptChallenge('c1'));
    expect(challenge!.status).toBe('accepted');
  });

  it('lands on accepted in the opposite order too', async () => {
    challenge = doubles();
    await as('p3', () => acceptChallenge('c1'));
    await as('p2', () => acceptChallenge('c1'));
    expect(challenge!.status).toBe('accepted');
  });

  it('one rejection ends it even after another participant accepted', async () => {
    challenge = doubles();
    await as('p2', () => acceptChallenge('c1'));
    await as('p3', () => rejectChallenge('c1'));
    expect(challenge!.status).toBe('rejected');
  });
});

describe('rejectChallenge', () => {
  it('refuses the creator rejecting their own challenge', async () => {
    challenge = { created_by: ME, status: 'proposed', participants: [{ player_id: ME, confirmation_status: 'pending' }] };
    const res = await rejectChallenge('c1');
    expect(res).toEqual({ ok: false, error: 'Cannot reject your own challenge' });
  });

  it('rejects for a pending participant', async () => {
    challenge = { created_by: THEM, status: 'proposed', participants: [{ player_id: ME, confirmation_status: 'pending' }] };
    const res = await rejectChallenge('c1');
    expect(res.ok).toBe(true);
    expect(challenge!.status).toBe('rejected');
  });
});

describe('cancelChallenge', () => {
  it('lets only the creator cancel', async () => {
    challenge = { created_by: THEM, status: 'proposed', participants: [] };
    const res = await cancelChallenge('c1');
    expect(res).toEqual({ ok: false, error: 'Only the creator can cancel' });
  });

  it('refuses a challenge that has already moved on', async () => {
    challenge = { created_by: ME, status: 'completed', participants: [] };
    const res = await cancelChallenge('c1');
    expect(res).toEqual({ ok: false, error: 'Challenge cannot be cancelled in its current state' });
  });
});
