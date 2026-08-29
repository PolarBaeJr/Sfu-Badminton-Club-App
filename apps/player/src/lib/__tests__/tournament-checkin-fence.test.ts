import { describe, it, expect, beforeEach, vi } from 'vitest';

// THE QR SCAN WAS THE LAST UNFENCED CHECK-IN.
//
// 00201 moved every writer of an entry's status behind set_field_entry_status,
// which takes the event's field lock and re-reads both the entry and the event
// under it. The member's own per-event check-in (selfCheckIn) was moved. This
// path -- one scan at the door checking a member into every event of a
// tournament at once -- kept a direct service-role UPDATE and was missed,
// because the source census that was supposed to catch it looked only a fixed
// 600 characters past `.from()` for a write verb, and a long comment sat in
// between. See field-write-fence.test.ts for the window that hid it.
//
// The direct write was not naive: it re-asserted the ENTRY status in its WHERE
// clause, so two rapid scans could not both claim a row. What no WHERE clause
// on tournament_participants can express is a condition on tournament_events,
// so the EVENT status stayed a JS-side read taken several awaits earlier --
// with the waiver assertion in the gap.
//
// There is deliberately no fake Postgres here; the locking is the database's
// half. These pin the application half: that the fenced function is what runs,
// that no unfenced UPDATE survives, and that each outcome reaches the member as
// the right sentence.

const store = vi.hoisted(() => ({
  rpc: [] as Array<{ fn: string; args: Record<string, unknown> }>,
  rpcResults: [] as Array<Record<string, unknown>>,
  tableWrites: [] as string[],
  entries: [] as Array<Record<string, unknown>>,
}));

vi.mock('../supabase-server', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  createServiceRoleClient: () => ({
    rpc: (fn: string, args: Record<string, unknown>) => {
      store.rpc.push({ fn, args });
      // One result per call, so a scan spanning several events can give a
      // different outcome per event -- which is the whole shape of this path.
      const next = store.rpcResults.shift() ?? { ok: true, already: false };
      return Promise.resolve({ data: next, error: null });
    },
    from: (table: string) => {
      const chain: Record<string, unknown> = {};
      const self = () => chain;
      chain.select = self; chain.eq = self; chain.in = self;
      chain.update = () => { store.tableWrites.push(table); return chain; };
      chain.maybeSingle = () => Promise.resolve({
        data: table === 'tournament_checkin_tokens'
          ? { tournament_id: 't1' }
          : { name: 'Test Cup', suspended_at: null, suspension_reason: null },
        error: null,
      });
      // The entries read is awaited directly rather than through maybeSingle,
      // so the chain itself has to be thenable.
      chain.then = (resolve: (v: unknown) => unknown) =>
        Promise.resolve({ data: store.entries, error: null }).then(resolve);
      return chain;
    },
  }),
}));

vi.mock('../actions/_shared', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  requirePlayer: () => Promise.resolve({ id: 'p1', is_banned: false }),
  assertCurrentWaiver: () => Promise.resolve(),
}));
vi.mock('../event-waiver', () => ({ assertMyEventWaiverSigned: () => Promise.resolve() }));
vi.mock('next/cache', () => ({ revalidatePath: () => {} }));
vi.mock('next/headers', () => ({ headers: () => Promise.resolve(new Map()) }));

const { checkInToTournament } = await import('../tournament-checkin');

const TOKEN = 'a1'.repeat(24);
const entry = (id: string, eventStatus = 'checkin') => ({
  id, status: 'registered',
  event: { id: `e-${id}`, event_type: 'mens_singles', status: eventStatus, tournament_id: 't1' },
});

beforeEach(() => {
  store.rpc = []; store.rpcResults = []; store.tableWrites = [];
  store.entries = [entry('pt1')];
});

describe('the QR check-in scan goes through the field fence', () => {
  it('calls set_field_entry_status, not a bare participant UPDATE', async () => {
    const r = await checkInToTournament(TOKEN);

    expect(r.ok).toBe(true);
    expect(store.rpc.map(c => c.fn)).toEqual(['set_field_entry_status']);
    // The whole finding: no unfenced write to the entry row.
    expect(store.tableWrites).not.toContain('tournament_participants');
  });

  it('checks in every event on one scan, one fenced call each', async () => {
    // The fence keys on the EVENT, and a scan spans several, so there is no
    // single lock covering them all -- one call per entry is the shape.
    store.entries = [entry('pt1'), entry('pt2'), entry('pt3')];
    store.rpcResults = [
      { ok: true, already: false },
      { ok: true, already: false },
      { ok: true, already: false },
    ];

    const r = await checkInToTournament(TOKEN);

    expect(store.rpc).toHaveLength(3);
    expect(store.rpc.map(c => c.args.p_entry_id)).toEqual(['pt1', 'pt2', 'pt3']);
    if (r.ok) expect(r.data.checkedIn).toHaveLength(3);
  });

  it('names no officer, because a self-scan had none', async () => {
    await checkInToTournament(TOKEN);
    // Writing the member's own id into checked_in_by would claim an exec was
    // standing there.
    expect(store.rpc[0]!.args.p_actor).toBeNull();
    expect(store.rpc[0]!.args.p_is_pair).toBe(false);
    expect(store.rpc[0]!.args.p_new_status).toBe('checked_in');
  });

  it('reports "already in" from the fence, not from a second read', async () => {
    // `already` is decided from the status the fence read UNDER the lock. The
    // old path asked a follow-up query what the row was now, which could move
    // again between the write and that read.
    store.rpcResults = [{ ok: true, already: true }];

    const r = await checkInToTournament(TOKEN);

    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data.alreadyIn).toHaveLength(1);
      expect(r.data.checkedIn).toHaveLength(0);
    }
  });

  it('claims nothing when the fence refuses -- neither checked in nor already', async () => {
    // A draw published between the JS read and the write, or an officer
    // withdrawing someone mid-queue. Reporting either list would be a lie, and
    // the member at the door is told check-in is not open.
    store.rpcResults = [{ ok: false, reason: 'event_status' }];

    const r = await checkInToTournament(TOKEN);

    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/not open/i);
  });

  it('still refuses locally before the event is accepting check-in', async () => {
    // The JS pre-filter stays: it is a cheap early exit, and it keeps the
    // self-scan narrower than an officer's desk action, which 00201
    // deliberately allows once a draw exists.
    store.entries = [entry('pt1', 'registration')];

    const r = await checkInToTournament(TOKEN);

    expect(r.ok).toBe(false);
    expect(store.rpc).toHaveLength(0);
  });
});
