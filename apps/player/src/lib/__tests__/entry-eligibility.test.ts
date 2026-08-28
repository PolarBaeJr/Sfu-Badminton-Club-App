import { describe, it, expect, beforeEach, vi } from 'vitest';

// THE FIVE ELIGIBILITY REFUSALS 00196 MOVED INSIDE THE LOCK.
//
// enter_tournament_event now decides suspension, tournament status, membership,
// the member's own ban and pair membership under the locks the entry is decided
// under, instead of trusting reads the caller took hundreds of milliseconds
// earlier. That half is the database's and was exercised directly against
// staging — every gate, plus a two-session probe showing an entry genuinely
// queues behind the field lock.
//
// THIS FILE PINS THE OTHER HALF. Each of those refusals is permanent: the
// tournament was archived, the member was banned, the exec paired them. Falling
// through to the default arm turns every one of them into "please try again
// shortly", which is an instruction the member can follow forever and an
// instruction that will never work. The regression is silent — the entry is
// correctly refused either way — so nothing but a test catches it.

const store = vi.hoisted(() => ({
  rpcResult: {} as Record<string, unknown>,
  event: {} as Record<string, unknown>,
}));

vi.mock('../supabase-server', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  createServiceRoleClient: () => ({
    rpc: () => Promise.resolve({ data: store.rpcResult, error: null }),
    from: (table: string) => {
      const chain: Record<string, unknown> = {};
      const self = () => chain;
      chain.select = self; chain.eq = self; chain.or = self; chain.limit = self;
      chain.insert = () => Promise.resolve({ error: null });
      chain.upsert = () => Promise.resolve({ error: null });
      chain.update = self;
      chain.maybeSingle = () => Promise.resolve({
        data: table === 'tournament_events' ? store.event
          : table === 'ratings' ? { singles_elo: 1000, doubles_elo: 1000 }
          : null,
        error: null,
      });
      chain.single = () => Promise.resolve({ data: null, error: null });
      return chain;
    },
  }),
}));

vi.mock('../actions/_shared', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  requirePlayer: () => Promise.resolve({
    id: 'p1', is_banned: false, membership_type: 'internal', competition_category: 'mens',
  }),
  assertCurrentWaiver: () => Promise.resolve(),
}));
vi.mock('next/cache', () => ({ revalidatePath: () => {} }));
vi.mock('next/headers', () => ({ headers: () => Promise.resolve(new Map()) }));

const { registerForEvent } = await import('../tournament-actions');

beforeEach(() => {
  // An event whose every app-side gate PASSES. That is the whole point: the
  // only way to reach the switch arms below is for the application's copy of a
  // fact and the database's copy to disagree, which is the race 00196 closes.
  store.event = {
    id: 'e1',
    status: 'registration',
    event_type: 'open_singles',
    tournament_id: 't1',
    max_participants: 32,
    tournament: {
      status: 'active',
      suspended_at: null,
      suspension_reason: null,
      waiver_text: null,
      allowed_memberships: ['internal', 'alumni', 'external'],
    },
  };
});

describe('every eligibility refusal reaches the member as its own sentence', () => {
  const CASES: Array<[string, Record<string, unknown>, RegExp]> = [
    ['tournament_suspended', { suspension_reason: 'gym flooded' }, /suspended: gym flooded/],
    // The reason is optional, and the sentence has to survive its absence
    // rather than rendering "suspended: null".
    ['tournament_suspended', {}, /currently suspended$/],
    ['tournament_closed', { status: 'archived' }, /has been archived, so you cannot enter this event/],
    ['membership_not_allowed', { allowed: ['alumni'] }, /Alumni members only/],
    ['player_suspended', {}, /account is suspended/],
    ['already_in_pair', {}, /already in a pair/],
  ];

  for (const [reason, extra, sentence] of CASES) {
    it(`${reason}${Object.keys(extra).length ? ` (${Object.keys(extra).join(', ')})` : ''} is not the generic retry`, async () => {
      store.rpcResult = { ok: false, reason, ...extra };
      const r = await registerForEvent('e1');
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.error).toMatch(sentence);
        // The default arm. A reason the switch forgets lands here, and the
        // member is told to retry something that will never succeed.
        expect(r.error).not.toMatch(/try again shortly/);
      }
    });
  }

  // The control. Without this the assertions above would still pass if the
  // switch had been replaced by a single catch-all sentence.
  it('still falls through to the retry message for a reason nobody has written yet', async () => {
    store.rpcResult = { ok: false, reason: 'something_invented_later' };
    const r = await registerForEvent('e1');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/try again shortly/);
  });
});
