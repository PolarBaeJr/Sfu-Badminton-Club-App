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
    // withdrawing someone mid-queue. Reporting either list would be a lie.
    //
    // "CLOSED", not "not open yet", and the distinction is exact rather than a
    // wording preference: an entry only reaches the RPC if the prefilter saw
    // its event in `checkin`, so a fence refusal means the event moved FORWARD
    // underneath the scan. There is no transition back to registration.
    store.rpcResults = [{ ok: false, reason: 'event_status' }];

    const r = await checkInToTournament(TOKEN);

    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/closed for this event/i);
  });

  it('REPORTS a partial refusal instead of calling the whole scan a success', async () => {
    // The round-18 finding. Two events on one scan: the first checks in, and
    // an officer withdraws them from the second while the loop is still
    // running. The all-empty test passes on the strength of the first, so the
    // refusal used to be dropped on the floor and the member saw a screen
    // headed "Checked in".
    store.entries = [entry('pt1'), entry('pt2')];
    store.rpcResults = [
      { ok: true, already: false },
      { ok: false, reason: 'entry_status' },
    ];

    const r = await checkInToTournament(TOKEN);

    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data.checkedIn).toHaveLength(1);
      expect(r.data.refused).toHaveLength(1);
      // Said in words the person at the door can act on, not a reason code.
      expect(r.data.refused[0]!.detail).toMatch(/no longer in this event/i);
      // And it is NOT quietly counted as a success anywhere.
      expect(r.data.alreadyIn).toHaveLength(0);
    }
  });

  it('leaves refused empty when every entry checked in', async () => {
    // The other direction: a guard that reported a refusal on a clean scan
    // would turn every ordinary check-in into "Partly checked in".
    store.entries = [entry('pt1'), entry('pt2')];
    store.rpcResults = [{ ok: true, already: false }, { ok: true, already: true }];

    const r = await checkInToTournament(TOKEN);

    expect(r.ok).toBe(true);
    if (r.ok) expect(r.data.refused).toHaveLength(0);
  });

  // ROUND 19. Fixing the RPC-refusal branch was not the whole of it: two JS
  // PREFILTERS above the loop also dropped entries with a bare `continue`, so
  // an entry that never reached the RPC never reached `refused` either. The
  // partial-success screen came back for a member whose second event was
  // withdrawn or simply not open yet.
  it('reports an entry whose check-in has CLOSED as a refusal', async () => {
    // Codex's round-19 sequence, with the status that makes it a refusal.
    // alreadyIn is non-empty, so the all-empty test below cannot fire and the
    // second event used to vanish from the screen entirely.
    store.entries = [entry('pt1'), entry('pt2', 'live')];
    store.rpcResults = [{ ok: true, already: true }];

    const r = await checkInToTournament(TOKEN);

    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data.alreadyIn).toHaveLength(1);
      expect(r.data.refused).toHaveLength(1);
      expect(r.data.refused[0]!.detail).toMatch(/closed/i);
      expect(r.data.pending).toHaveLength(0);
    }
    // And it really was the prefilter: only the first entry reached the fence.
    expect(store.rpc).toHaveLength(1);
  });

  // THE OVER-CORRECTION, which is its own defect and not a softening of the one
  // above. Reporting every not-yet-open event as a refusal headed almost every
  // ordinary scan "Partly checked in", because a tournament runs its events in
  // sequence and the query fetches ALL of a member's entries.
  it('does NOT call a later event a refusal, so an ordinary scan stays clean', async () => {
    store.entries = [entry('pt1'), entry('pt2', 'registration')];
    store.rpcResults = [{ ok: true, already: false }];

    const r = await checkInToTournament(TOKEN);

    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data.checkedIn).toHaveLength(1);
      // Reported, so it does not vanish...
      expect(r.data.pending).toHaveLength(1);
      // ...but NOT as a failure. This empty list is what keeps the screen
      // headed "Checked in".
      expect(r.data.refused).toHaveLength(0);
    }
  });

  it('reports an entry the withdrawn prefilter skipped', async () => {
    const withdrawn = { ...entry('pt2'), status: 'withdrawn' };
    store.entries = [entry('pt1'), withdrawn];
    store.rpcResults = [{ ok: true, already: false }];

    const r = await checkInToTournament(TOKEN);

    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data.checkedIn).toHaveLength(1);
      expect(r.data.refused).toHaveLength(1);
      expect(r.data.refused[0]!.detail).toMatch(/no longer in this event/i);
      expect(r.data.pending).toHaveLength(0);
    }
    expect(store.rpc).toHaveLength(1);
  });

  it('says WHY when a scan lands nothing at all, rather than "not open yet"', async () => {
    // A member whose only entry was withdrawn used to be told check-in was not
    // open yet -- true of nothing, and it sends them back to queue again.
    store.entries = [{ ...entry('pt1'), status: 'withdrawn' }];

    const r = await checkInToTournament(TOKEN);

    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/no longer in this event/i);
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
