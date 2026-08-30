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

// ===========================================================================
// THE COMPETITION CATEGORY, RE-ASKED UNDER THE LOCK (00200)
// ===========================================================================
//
// competition_category is writable from exactly one place — the console — and
// the member's own screen reads it hundreds of milliseconds before the entry
// lands. So this is the one eligibility fact the app-side gate could never win
// a race on, and until 00200 enter_tournament_event never asked again.
//
// The event here is gendered and the member's declared category MATCHES it, so
// screenSelfEntry passes and the switch below is genuinely reachable. That is
// the whole shape of the race: an exec changed the answer in between.
describe('the category refusals the database now makes', () => {
  beforeEach(() => { store.event.event_type = 'mens_singles'; });

  it('undeclared reaches the member as the Settings remedy, not a retry', async () => {
    store.rpcResult = { ok: false, reason: 'category_undeclared', event_type: 'mens_singles' };
    const r = await registerForEvent('e1');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toMatch(/Set your Gender in Settings/);
      expect(r.error).toMatch(/enter an Open event instead/i);
      expect(r.error).not.toMatch(/try again shortly/);
    }
  });

  it('mismatch reaches the member as the exec remedy, not a retry', async () => {
    store.rpcResult = { ok: false, reason: 'category_mismatch', event_type: 'mens_singles' };
    const r = await registerForEvent('e1');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toMatch(/not open to your declared Gender/);
      expect(r.error).toMatch(/ask an exec/);
      expect(r.error).not.toMatch(/try again shortly/);
    }
  });

  // THE SENTENCE HAS ONE SOURCE. If the switch arms above ever grow their own
  // wording, a member who loses the race reads something different from one who
  // never entered it — for the same refusal, about the same event. Comparing
  // against screenSelfEntry is what makes that impossible to do quietly.
  it('says exactly what the member would have read without the race', async () => {
    const { screenSelfEntry } = await import('@badminton/shared');

    const undeclared = screenSelfEntry('mens_singles', null);
    store.rpcResult = { ok: false, reason: 'category_undeclared' };
    const a = await registerForEvent('e1');
    expect(undeclared.ok).toBe(false);
    if (!a.ok && !undeclared.ok) expect(a.error).toBe(undeclared.message);

    const mismatch = screenSelfEntry('mens_singles', 'womens');
    store.rpcResult = { ok: false, reason: 'category_mismatch' };
    const b = await registerForEvent('e1');
    expect(mismatch.ok).toBe(false);
    if (!b.ok && !mismatch.ok) expect(b.error).toBe(mismatch.message);
  });

  // The refusal must be built from the EVENT, not from anything the function
  // sends back about the member. A fence that returned the member's category
  // would undo the disclosure property screenSelfEntry's own comment describes,
  // and the first sign of it would be a sentence that changes when the payload
  // does.
  it('ignores a category the database has no business returning', async () => {
    store.rpcResult = { ok: false, reason: 'category_mismatch', competition_category: 'womens' };
    const r = await registerForEvent('e1');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).not.toMatch(/women/i);
  });
});
