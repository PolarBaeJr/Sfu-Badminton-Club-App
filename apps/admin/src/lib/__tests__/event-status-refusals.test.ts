import { describe, it, expect, vi, beforeEach } from 'vitest';

// WHAT THIS IS ABOUT.
//
// setEventStatus is the Go-Live button. It carries five refusals the exec has
// to be able to read — a stale stepper, a suspended tournament, an empty pool,
// an ungenerated bracket, and another desk having moved the event already — and
// every one of them was THROWN. Next.js replaces anything thrown out of a
// Server Action in production with a generic message, and EventHeader's catch
// renders `err.message` into a toast, so on the deployed console the one press
// the whole page exists for failed with a sentence that said nothing.
//
// The fix is the same one 599b8a0 / 057f5b3 / 20e8bea applied to the actions
// next door: refuse by RETURNING an ActionResult. This test proves the returned
// shape, because that is the half that production changes — a test that only
// asserted "it refuses" passes just as well against the thrown version, which
// is exactly how this survived three passes over the same file.

const single = vi.fn();
const matchCount = vi.fn();

// One chainable stub for both tables the action reads. `single()` answers the
// tournament_events lookup; the head-count select answers the fixture guard.
function makeClient() {
  const chain: Record<string, unknown> = {};
  const self = () => chain;
  Object.assign(chain, {
    select: vi.fn(() => chain),
    eq: vi.fn(() => chain),
    update: vi.fn(() => chain),
    single,
    then: undefined,
  });
  return {
    from: vi.fn((table: string) => {
      if (table === 'tournament_matches') {
        return {
          select: vi.fn(() => ({ eq: vi.fn(() => ({ eq: vi.fn(() => matchCount()), then: undefined, ...matchCount() })) })),
        };
      }
      return self();
    }),
  };
}

vi.mock('@sentry/nextjs', () => ({ captureException: vi.fn() }));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('../supabase-server', () => ({ createAdminClient: () => makeClient() }));
vi.mock('../audit', () => ({ logAudit: vi.fn() }));
vi.mock('../tournament-actions/_internal', () => ({
  requireCapability: vi.fn(async () => ({ id: 'admin-1' })),
  revalidateEventPaths: vi.fn(),
  assertTournamentNotSuspended: vi.fn(async () => {}),
  forfeitOutOfEventEntries: vi.fn(async () => ({ forfeited: 0, unresolved: 0 })),
}));

const EVENT = '11111111-1111-4111-8111-111111111111';

beforeEach(() => {
  single.mockReset();
  matchCount.mockReset();
  matchCount.mockReturnValue({ count: 0 });
});

describe('setEventStatus refuses by returning, not by throwing', () => {
  it('a step the event cannot take comes back as a readable value', async () => {
    // Registration -> live skips check-in and the draw. The old code threw
    // `Invalid transition from registration to live`; in production the exec
    // saw Next's generic string instead.
    single.mockResolvedValue({
      data: { id: EVENT, tournament_id: 't1', status: 'registration', format: 'single_elimination', event_type: 'mens_singles' },
    });
    const { setEventStatus } = await import('../tournament-actions/events');
    const res = await setEventStatus(EVENT, 'live');

    // The shape is the assertion. `ok: false` with a sentence is what
    // EventHeader's `if (!res.ok)` branch can actually render.
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain('cannot go from registration to live');
  });

  it('going live with no bracket says so, rather than failing generically', async () => {
    single.mockResolvedValue({
      data: { id: EVENT, tournament_id: 't1', status: 'bracket_generated', format: 'single_elimination', event_type: 'mens_singles' },
    });
    matchCount.mockReturnValue({ count: 0 });
    const { setEventStatus } = await import('../tournament-actions/events');
    const res = await setEventStatus(EVENT, 'live');

    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain('no bracket has been generated');
  });

  it('a pool with no fixtures says so too', async () => {
    single.mockResolvedValue({
      data: { id: EVENT, tournament_id: 't1', status: 'pool_generated', format: 'pool_to_bracket', event_type: 'mens_singles' },
    });
    matchCount.mockReturnValue({ count: 0 });
    const { setEventStatus } = await import('../tournament-actions/events');
    const res = await setEventStatus(EVENT, 'pool_live');

    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain('no fixtures have been generated');
  });

  // 'Event not found' is deliberately NOT in here. It stays a plain Error, the
  // classification tournament-refusal-classification.test.ts already pins, and
  // that decision is explicitly flagged there as one to take on its own rather
  // than to change while fixing something else.
});
