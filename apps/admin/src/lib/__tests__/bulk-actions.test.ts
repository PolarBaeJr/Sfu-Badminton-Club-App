import { describe, it, expect, beforeEach, vi } from 'vitest';

// The bulk server actions on /players, /sessions and the two fee desks.
//
// THE ONE CLAIM THESE TESTS EXIST TO CHECK is that a bulk action is a LOOP over
// the ordinary single-record action and never a batched write. The tempting
// shape — `.update({...}).in('id', ids)` — is one statement, and it runs none of
// the per-record guards: approvePlayer's "only a pending signup" precondition,
// assertPlayerFieldAccess, the refusal to mark a suspended member inactive, and
// the audit row whose old_value is read from THAT row. It is also the shape this
// codebase has already been bitten by: an unqualified UPDATE needs no SELECT
// grant, which is how the elo_review write got out.
//
// So what is asserted here is per-record behaviour, out of a bulk call: one
// audit row and one email each, a refusal on one member that does not touch the
// others, and a gate that stops the whole thing before a single write.

type Row = Record<string, unknown>;

const store = vi.hoisted(() => ({
  db: {} as Record<string, Row[]>,
  emails: [] as string[],
  /** Flipped by the test that checks an uncapable officer writes nothing. */
  gateError: null as string | null,
  gateCalls: [] as string[],
  /** Every message runAction handed to Sentry. A loop over a roster reaches an
   *  ordinary refusal constantly — "no fee row", "already unpaid" — and none of
   *  them is a fault to page somebody about. */
  sentry: [] as string[],
}));

const makeClient = vi.hoisted(() => () => {
  function query(table: string) {
    // Predicates rather than column/value pairs, so `.is()` can express IS NULL:
    // in a plain-object store an absent key and an explicit null are the same
    // state, and `=== null` only matches the second.
    const filters: Array<(row: Row) => boolean> = [];
    let op: 'select' | 'insert' | 'update' | 'delete' = 'select';
    let payload: Row = {};
    let inserted: Row | null = null;

    const matching = () => (store.db[table] ?? []).filter((r) => filters.every((f) => f(r)));

    const run = () => {
      if (op === 'insert') {
        // The INSERTED row, not the first row of the table. `.insert(…)
        // .select('id').single()` is how markFeePaid reads back the row it just
        // created, and its audit entry files that id as the target.
        return { data: inserted ? [{ ...inserted }] : [], error: null };
      }
      if (op === 'update') {
        const hit = matching();
        for (const r of hit) Object.assign(r, payload);
        return { data: hit.map((r) => ({ ...r })), error: null };
      }
      if (op === 'delete') {
        const hit = matching();
        store.db[table] = (store.db[table] ?? []).filter((r) => !hit.includes(r));
        return { data: hit.map((r) => ({ ...r })), error: null };
      }
      return { data: matching().map((r) => ({ ...r })), error: null };
    };

    const api = {
      select() { return api; },
      insert(p: Row) {
        // A generated key where the payload names none, the way every table here
        // has a DEFAULT on its id.
        const row: Row = { id: `${table}-${(store.db[table] ?? []).length + 1}`, ...p };
        (store.db[table] ??= []).push(row);
        op = 'insert';
        inserted = row;
        return api;
      },
      update(p: Row) { op = 'update'; payload = p; return api; },
      delete() { op = 'delete'; return api; },
      eq(c: string, v: unknown) { filters.push((r) => r[c] === v); return api; },
      is(c: string, v: unknown) {
        filters.push((r) => (v === null ? r[c] == null : r[c] === v));
        return api;
      },
      async single() { const r = run(); return { data: r.data?.[0] ?? null, error: r.error }; },
      async maybeSingle() { const r = run(); return { data: r.data?.[0] ?? null, error: r.error }; },
      then(resolve: (v: unknown) => unknown) { return Promise.resolve(run()).then(resolve); },
    };
    return api;
  }
  return {
    from: (table: string) => query(table),
    rpc: async () => ({ data: 'K3F9TQ2', error: null }),
  };
});

vi.mock('next/cache', () => ({ revalidatePath: () => {} }));
vi.mock('@sentry/nextjs', () => ({
  captureException: (err: unknown) => {
    store.sentry.push(err instanceof Error ? err.message : String(err));
  },
}));
vi.mock('../supabase-server', () => ({ createAdminClient: makeClient }));
vi.mock('../notify', () => ({ notifyPlayers: async () => {} }));
vi.mock('../session-reminders', () => ({ remindSessionGoers: async () => ({ notified: 0 }) }));
// The seam the action tests mock, and the reason _shared exists at all. One
// mock covers the outer gate AND the per-record gate, because both call this.
vi.mock('../actions/_shared', () => ({
  requireCapability: async (capability: string) => {
    store.gateCalls.push(capability);
    if (store.gateError) throw new Error(store.gateError);
    return { id: 'exec-1', role: 'player', is_exec: true };
  },
}));
vi.mock('../audit', () => ({
  logAdminAudit: async (client: { from: (t: string) => { insert: (r: Row) => unknown } }, entry: Row) => {
    await client.from('audit_logs').insert(entry);
  },
}));
vi.mock('@badminton/shared', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@badminton/shared')>()),
  sendPlayerApprovedEmail: async (email: string) => { store.emails.push(email); },
}));

import {
  bulkApprovePlayers,
  bulkUpdatePlayers,
  bulkUpdateSessions,
  bulkArchiveSessions,
  bulkDeleteSessions,
  bulkMarkFeesPaid,
  bulkWaiveFees,
  bulkMarkFeesUnpaid,
  bulkMarkTournamentFeesPaid,
  bulkMarkTournamentFeesUnpaid,
} from '../actions/bulk';
import { MAX_BULK_TARGETS } from '../bulk';

const PENDING = ['p-ada', 'p-bao', 'p-kiera'];

const players = () => store.db.players ?? [];
const player = (id: string) => players().find((p) => p.id === id)!;
const auditsOf = (type: string) => (store.db.audit_logs ?? []).filter((r) => r.action_type === type);
const REASON = 'Signed up at the club fair';

beforeEach(() => {
  store.emails = [];
  store.gateError = null;
  store.gateCalls = [];
  store.sentry = [];
  store.db = {
    players: PENDING.map((id) => ({
      id,
      status: 'pending_approval',
      active_flag: false,
      is_banned: false,
      membership_type: 'external',
      email: `${id}@sfu.ca`,
      full_name: id,
    })),
    sessions: [
      { id: 's-1', status: 'open', name: 'Tuesday Drop-in' },
      { id: 's-2', status: 'open', name: 'Thursday Drop-in' },
    ],
    session_attendance: [{ id: 'att-1', session_id: 's-1' }],
    audit_logs: [],
  };
});

describe('approving a whole intake', () => {
  it('lets each one in individually, with their own audit row and their own email', async () => {
    // The club owner's ask: "it will take ages to approve a ton of people". What
    // must NOT be lost in doing it faster is that each approval is still a real
    // approval — a member code, a welcome, and a line in the log naming who
    // clicked.
    const res = await bulkApprovePlayers(PENDING, 'competitive', REASON);

    expect(res.ok).toBe(true);
    if (res.ok) expect(res.data).toMatchObject({ attempted: 3, succeeded: 3, failures: [] });
    expect(players().every((p) => p.status === 'competitive')).toBe(true);
    expect(auditsOf('player_approved')).toHaveLength(3);
    expect(store.emails.sort()).toEqual(PENDING.map((id) => `${id}@sfu.ca`).sort());
  });

  it('names the one it could not, and still lets the others in', async () => {
    // A removed member (status 'suspended', written by the admin-only
    // removePlayer) must not come back through an exec-level bulk approve —
    // and the officer must be told which one, not handed a silent 2-of-3.
    player('p-bao').status = 'suspended';

    const res = await bulkApprovePlayers(PENDING, 'competitive', REASON);

    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.data.succeeded).toBe(2);
      expect(res.data.failures).toHaveLength(1);
      expect(res.data.failures[0]!.id).toBe('p-bao');
      expect(res.data.failures[0]!.error).toMatch(/only a pending signup/i);
    }
    expect(player('p-bao').status).toBe('suspended');
    expect(player('p-kiera').status).toBe('competitive');
    // The one that was refused is not emailed "you're in".
    expect(store.emails).not.toContain('p-bao@sfu.ca');
  });

  it('approves a repeated id once', async () => {
    const res = await bulkApprovePlayers(['p-ada', 'p-ada'], 'recreational', REASON);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.data.attempted).toBe(1);
    expect(auditsOf('player_approved')).toHaveLength(1);
  });
});

describe('the same edit to several members', () => {
  it('writes only the fields it was given, to each of them', async () => {
    await bulkApprovePlayers(PENDING, 'competitive', REASON);
    store.db.audit_logs = [];

    const res = await bulkUpdatePlayers(PENDING, {
      membership_type: 'internal',
      reason: 'Corrected after the membership audit',
    });

    expect(res.ok).toBe(true);
    expect(players().every((p) => p.membership_type === 'internal')).toBe(true);
    // Division untouched: the bar left it on "leave as they are", so the key
    // was never in the payload.
    expect(players().every((p) => p.status === 'competitive')).toBe(true);
    expect(auditsOf('player_updated')).toHaveLength(3);
  });

  it('carries the one typed reason onto every row it writes', async () => {
    await bulkApprovePlayers(['p-ada'], 'competitive', REASON);
    store.db.audit_logs = [];

    await bulkUpdatePlayers(['p-ada'], { membership_type: 'alumni', reason: 'Graduated in April' });

    expect(auditsOf('player_updated')[0]).toMatchObject({ reason: 'Graduated in April' });
  });

  it('refuses to let a pending signup into a division through Edit, and names them', async () => {
    // THE DANGEROUS COMBINATION, and the one this bar makes easy to reach: the
    // Needs Attention tab is where a selection of pending signups lives, and the
    // Edit dialog offers a Division select right beside the Approve button.
    // Going through updatePlayer would set status='competitive' and skip all
    // three things approval means — the membership code, the "you're in" email,
    // and the player_approved row saying anyone was ever let in — while also
    // reaching an approval-shaped change on players.update.write alone.
    //
    // The others in the same call still go through: a division move for members
    // who are already in is an ordinary edit.
    await bulkApprovePlayers(['p-ada', 'p-bao'], 'recreational', REASON);
    store.db.audit_logs = [];
    store.emails = [];

    const res = await bulkUpdatePlayers(PENDING, {
      status: 'competitive',
      reason: 'Moved up after the ladder night',
    });

    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.data.succeeded).toBe(2);
      expect(res.data.failures).toHaveLength(1);
      expect(res.data.failures[0]!.id).toBe('p-kiera');
      expect(res.data.failures[0]!.error).toMatch(/approval/i);
    }
    expect(player('p-kiera').status).toBe('pending_approval');
    expect(player('p-ada').status).toBe('competitive');
    // Not quietly admitted by another name: no welcome, no approval row.
    expect(store.emails).toEqual([]);
    expect(auditsOf('player_approved')).toHaveLength(0);
    expect(auditsOf('player_updated')).toHaveLength(2);
  });
});

describe('the gate', () => {
  it('refuses an officer without the capability before touching a single row', async () => {
    // The whole point of the outer gate: one sentence back, not twenty-five
    // identical failures — and, either way, nothing written.
    store.gateError = 'Admin or exec access required';

    const res = await bulkApprovePlayers(PENDING, 'competitive', REASON);

    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/access required/i);
    expect(players().every((p) => p.status === 'pending_approval')).toBe(true);
    expect(auditsOf('player_approved')).toHaveLength(0);
    expect(store.emails).toEqual([]);
  });

  it('asks for the same capability the single-record action asks for', async () => {
    // Not a second answer to "who may do this" — the SAME constant, so the two
    // cannot drift. Every id in the loop re-asks, which is what protects the
    // write; the first call is the one that produces a readable refusal.
    await bulkApprovePlayers(['p-ada'], 'competitive', REASON);
    expect(new Set(store.gateCalls)).toEqual(new Set(['players.approve.write']));

    store.gateCalls = [];
    await bulkArchiveSessions(['s-1'], 'End of the fall term');
    expect(new Set(store.gateCalls)).toEqual(new Set(['sessions.archive.write']));
  });

  it('refuses a list longer than one request may act on, and writes nothing', async () => {
    // Reached only by a hand-rolled POST — the console chunks. Every exported
    // argument of a server action is a client-controlled field.
    const many = Array.from({ length: MAX_BULK_TARGETS + 1 }, (_, i) => `p${i}`);
    const res = await bulkApprovePlayers(many, 'competitive', REASON);

    expect(res.ok).toBe(false);
    expect(auditsOf('player_approved')).toHaveLength(0);
    expect(store.gateCalls).toEqual([]);
  });
});

describe('sessions', () => {
  it('closes each night on its own, with its own audit row', async () => {
    const res = await bulkArchiveSessions(['s-1', 's-2'], 'End of the fall term');

    expect(res.ok).toBe(true);
    if (res.ok) expect(res.data).toMatchObject({ attempted: 2, succeeded: 2, failures: [] });
    expect((store.db.sessions ?? []).every((s) => s.status === 'closed')).toBe(true);
    expect(auditsOf('session_archived')).toHaveLength(2);
  });

  it('takes the attendance rows with a deletion, one session at a time', async () => {
    // Why Close and Delete stay two buttons: this is the club's record of who
    // actually turned up, and it goes with the night.
    const res = await bulkDeleteSessions(['s-1'], 'Duplicated by the import');

    expect(res.ok).toBe(true);
    expect((store.db.sessions ?? []).map((s) => s.id)).toEqual(['s-2']);
    expect(store.db.session_attendance).toEqual([]);
    expect(auditsOf('session_deleted')).toHaveLength(1);
  });

  it('refuses the whole thing when the reason is too short, before any write', async () => {
    const res = await bulkArchiveSessions(['s-1', 's-2'], 'x');

    expect(res.ok).toBe(true);
    // requireReason runs per record, inside archiveSession, so this arrives as
    // two named refusals rather than one — which is the honest shape: the loop
    // really did try each one.
    if (res.ok) {
      expect(res.data.succeeded).toBe(0);
      expect(res.data.failures).toHaveLength(2);
      expect(res.data.failures[0]!.error).toMatch(/needs a reason/i);
    }
    expect((store.db.sessions ?? []).every((s) => s.status === 'open')).toBe(true);
  });
});

describe('the same edit to several nights', () => {
  // The club owner's ask: "no way to mass edit sessions?", over six Friday rows
  // all reading TIME NOT SET.
  //
  // THESE ROWS ARE SEEDED HERE, NOT IN THE SHARED beforeEach, and their ids are
  // real uuids on purpose: patchSession parses the id (the archive/delete pair
  // never did), so the 's-1'/'s-2' the other blocks use would come back as
  // invalid-uuid refusals. Their assertions count the sessions table, so the
  // rows cannot be added globally either.
  const FRI_1 = '11111111-1111-4111-8111-111111111111';
  const FRI_2 = '22222222-2222-4222-8222-222222222222';
  const NIGHTS = [FRI_1, FRI_2];
  const WHY = 'Gym double-booked, moved to Central';
  const night = (id: string) => (store.db.sessions ?? []).find((s) => s.id === id)!;

  beforeEach(() => {
    (store.db.sessions ??= []).push(
      { id: FRI_1, status: 'open', name: 'Friday Drop-in', date: '2026-09-11', start_time: null, end_time: null, location: 'West Gym', track: 'all', notes: 'Bring the good nets' },
      { id: FRI_2, status: 'open', name: 'Friday Drop-in', date: '2026-09-18', start_time: null, end_time: null, location: 'West Gym', track: 'all', notes: 'Ladder night' },
    );
  });

  it('writes only the fields it was given, to each night', async () => {
    const res = await bulkUpdateSessions(NIGHTS, { location: 'Central Gym' }, WHY);

    expect(res.ok).toBe(true);
    if (res.ok) expect(res.data).toMatchObject({ attempted: 2, succeeded: 2, failures: [] });
    expect(NIGHTS.map((id) => night(id).location)).toEqual(['Central Gym', 'Central Gym']);
    // The keys the dialog left on "leave as they are" were never in the patch,
    // so they are not in the UPDATE either. This is the whole difference from
    // updateSession, which would have blanked all three.
    expect(NIGHTS.every((id) => night(id).start_time === null)).toBe(true);
    expect(NIGHTS.every((id) => night(id).name === 'Friday Drop-in')).toBe(true);
    expect(night(FRI_1).notes).toBe('Bring the good nets');
    expect(auditsOf('session_updated')).toHaveLength(2);
  });

  it('sets a time on nights that had none — the TIME NOT SET case', async () => {
    const res = await bulkUpdateSessions(NIGHTS, { start_time: '19:00', end_time: '21:00' }, WHY);

    expect(res.ok).toBe(true);
    expect(NIGHTS.map((id) => night(id).start_time)).toEqual(['19:00', '19:00']);
    expect(NIGHTS.map((id) => night(id).end_time)).toEqual(['21:00', '21:00']);
  });

  it('clears a time to NULL, and says so in the audit row', async () => {
    night(FRI_1).start_time = '18:00';
    night(FRI_2).start_time = '18:00';

    const res = await bulkUpdateSessions(NIGHTS, { start_time: null }, WHY);

    expect(res.ok).toBe(true);
    // An explicit null really reaches the column. Were "clear" collapsed into
    // "leave alone" anywhere along the way, both rows would still read 18:00 and
    // the toast would still be green.
    expect(NIGHTS.every((id) => night(id).start_time === null)).toBe(true);
    // And the log says start_time: null rather than omitting the key — the same
    // "what was actually written" rule updateSession follows.
    const entry = auditsOf('session_updated')[0]!;
    expect(entry.new_value).toEqual({ start_time: null });
  });

  it('refuses a night that would end before it starts, and writes nothing', async () => {
    // The cross-field case no schema and no DB CHECK can catch: only end_time is
    // in the patch, and start_time is in the row.
    night(FRI_1).start_time = '19:00';
    night(FRI_1).end_time = '21:00';

    const res = await bulkUpdateSessions([FRI_1], { end_time: '17:00' }, WHY);

    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.data.succeeded).toBe(0);
      expect(res.data.failures[0]!.error).toMatch(/after start time/i);
    }
    expect(night(FRI_1).end_time).toBe('21:00');
  });

  it('carries the one typed reason onto every row it writes', async () => {
    await bulkUpdateSessions(NIGHTS, { track: 'competitive' }, WHY);

    const rows = auditsOf('session_updated');
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.reason === WHY)).toBe(true);
  });

  it('asks for the same capability the single-record edit asks for', async () => {
    store.gateCalls = [];
    await bulkUpdateSessions([FRI_1], { location: 'Central Gym' }, WHY);
    expect(new Set(store.gateCalls)).toEqual(new Set(['sessions.update.write']));
  });

  it('writes nothing at all for an officer without the capability', async () => {
    store.gateError = 'Admin or exec access required';

    const res = await bulkUpdateSessions(NIGHTS, { location: 'Central Gym' }, WHY);

    expect(res.ok).toBe(false);
    expect(NIGHTS.every((id) => night(id).location === 'West Gym')).toBe(true);
    expect(auditsOf('session_updated')).toHaveLength(0);
  });

  it('arrives as two named refusals when the reason is too short', async () => {
    const res = await bulkUpdateSessions(NIGHTS, { location: 'Central Gym' }, 'x');

    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.data.succeeded).toBe(0);
      expect(res.data.failures).toHaveLength(2);
      expect(res.data.failures[0]!.error).toMatch(/needs a reason/i);
    }
    expect(NIGHTS.every((id) => night(id).location === 'West Gym')).toBe(true);
  });

  it('refuses a column that is not on the allowlist, and leaves the row alone', async () => {
    // Every exported argument of a 'use server' function is a client-controlled
    // POST field, so this is reachable by a hand-rolled request. Asserted on the
    // STORED ROW, not just the error string: a schema that stripped the key
    // instead of rejecting it, or an UPDATE built by spreading the payload,
    // would both fail here.
    const res = await bulkUpdateSessions([FRI_1], { date: '2026-01-01' } as never, WHY);

    expect(res.ok).toBe(true);
    if (res.ok) expect(res.data.succeeded).toBe(0);
    expect(night(FRI_1).date).toBe('2026-09-11');
    expect(auditsOf('session_updated')).toHaveLength(0);
  });

  it('refuses a patch that asks for nothing', async () => {
    const res = await bulkUpdateSessions(NIGHTS, {}, WHY);

    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.data.succeeded).toBe(0);
      expect(res.data.failures[0]!.error).toMatch(/nothing to change/i);
    }
    expect(auditsOf('session_updated')).toHaveLength(0);
  });
});

// ─── THE FEE DESKS ────────────────────────────────────────────────────────────
//
// THE CLAIM THESE EXIST TO CHECK, over and above "it is a loop": that no bulk
// wrapper passes an AMOUNT. Omitting it is what makes markFeePaid fall back to
// the season's per-status fee for each member and markTournamentFeePaid keep the
// price already on each entrant's row. A single shared Amount field would bill a
// whole selection one number and overwrite every real tier price, so the tests
// below are written over MIXED populations and assert the STORED figures — an
// assertion about the arguments passed would not catch somebody adding the field
// later and wiring it through.
//
// THE OTHER HALF is that an ineligible row refuses LOUDLY and is not a fault. A
// selection is a snapshot of one server render, so a loop reaches "no fee row",
// "already paid" and "already unpaid" as a matter of course; each has to arrive
// as a named per-record refusal, must leave no audit row behind it, and must not
// be reported to Sentry.

const SEASON = '33333333-3333-4333-8333-333333333333';
const TOURNAMENT = '44444444-4444-4444-8444-444444444444';
// A competitive member, a recreational one, and a third with no fee row at all.
const ADA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const BAO = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const KIERA = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

const feesOf = (playerId: string) => (store.db.club_fees ?? []).filter((f) => f.player_id === playerId);
const feeOf = (playerId: string) => feesOf(playerId)[0];

describe('the season fee, over a selection', () => {
  beforeEach(() => {
    (store.db.players ??= []).push(
      { id: ADA, full_name: 'Ada Chen', status: 'competitive' },
      { id: BAO, full_name: 'Bao Nguyen', status: 'recreational' },
      { id: KIERA, full_name: 'Kiera Wong', status: 'competitive' },
    );
    // The two tiers priced differently, which is the whole point of the first
    // test: one shared amount could not be right for both.
    store.db.seasons = [
      { id: SEASON, competitive_fee_cents: 3000, recreational_fee_cents: 2000 },
    ];
    store.db.club_fees = [];
  });

  it('charges each member their own rate, because no amount is passed', async () => {
    // THE TEST THIS WHOLE FEATURE TURNS ON. A competitive member and a
    // recreational one, settled in one call: the stored figures have to be the
    // season's two different prices, not one number twice. markFeePaid derives
    // each from THAT member's status precisely because amount_cents is absent.
    const res = await bulkMarkFeesPaid([ADA, BAO], SEASON, 'cash', 'door-float');

    expect(res.ok).toBe(true);
    if (res.ok) expect(res.data).toMatchObject({ attempted: 2, succeeded: 2, failures: [] });
    expect(feeOf(ADA)).toMatchObject({ amount_cents: 3000, method: 'cash', reference: 'door-float', fee_type: 'dues' });
    expect(feeOf(BAO)).toMatchObject({ amount_cents: 2000, method: 'cash', reference: 'door-float', fee_type: 'dues' });
    expect(feeOf(ADA)!.paid_at).not.toBeNull();
    // The shared half of the answer really is shared, and the per-member half
    // really is not.
    expect(auditsOf('fee_marked_paid')).toHaveLength(2);
  });

  it('refuses a member who has already paid, and records the rest', async () => {
    store.db.club_fees = [
      { id: 'fee-ada', player_id: ADA, season_id: SEASON, fee_type: 'dues', amount_cents: 10000, paid_at: '2026-09-01T00:00:00.000Z', method: 'transfer', reference: null },
    ];

    const res = await bulkMarkFeesPaid([ADA, BAO], SEASON, 'cash');

    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.data.succeeded).toBe(1);
      expect(res.data.failures).toHaveLength(1);
      expect(res.data.failures[0]!.id).toBe(ADA);
      expect(res.data.failures[0]!.error).toMatch(/already recorded as paid/i);
    }
    // The $100 already on the record is not replaced by the season's $30.
    expect(feeOf(ADA)).toMatchObject({ amount_cents: 10000, method: 'transfer' });
    expect(feeOf(BAO)).toMatchObject({ amount_cents: 2000, method: 'cash' });
    expect(auditsOf('fee_marked_paid')).toHaveLength(1);
    // An officer acting on a stale roster is not a defect to page about.
    expect(store.sentry).toEqual([]);
  });

  it('waives each fee, and refuses one that is already waived', async () => {
    // A re-waive would replace the date the waiver was granted and the officer
    // who granted it, which is the whole reason those two fields are recorded.
    store.db.club_fees = [
      { id: 'fee-kiera', player_id: KIERA, season_id: SEASON, fee_type: 'dues', amount_cents: 0, paid_at: '2026-08-01T00:00:00.000Z', marked_by: 'exec-0', method: 'waived', reference: null },
    ];

    const res = await bulkWaiveFees([ADA, KIERA], SEASON);

    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.data.succeeded).toBe(1);
      expect(res.data.failures[0]!.id).toBe(KIERA);
      expect(res.data.failures[0]!.error).toMatch(/already waived/i);
    }
    expect(feeOf(ADA)).toMatchObject({ amount_cents: 0, method: 'waived' });
    // Untouched: same date, same officer.
    expect(feeOf(KIERA)).toMatchObject({ paid_at: '2026-08-01T00:00:00.000Z', marked_by: 'exec-0' });
    expect(auditsOf('fee_waived')).toHaveLength(1);
    expect(store.sentry).toEqual([]);
  });

  it('reverses a payment, and refuses both a row that is already unpaid and a member with no row', async () => {
    // The two states a loop over a roster reaches constantly, and the pair
    // e6f71300 turned from a silent success into a refusal. An audit row saying a
    // payment was undone when there was never a payment is worse than no row at
    // all, because it is the record somebody would later reason from.
    store.db.club_fees = [
      { id: 'fee-ada', player_id: ADA, season_id: SEASON, fee_type: 'dues', amount_cents: 3000, paid_at: '2026-09-01T00:00:00.000Z', marked_by: 'exec-0', method: 'cash' },
      { id: 'fee-bao', player_id: BAO, season_id: SEASON, fee_type: 'dues', amount_cents: 2000, paid_at: null, marked_by: null, method: null },
    ];

    const res = await bulkMarkFeesUnpaid([ADA, BAO, KIERA], SEASON);

    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.data.succeeded).toBe(1);
      expect(res.data.failures.map((f) => f.id)).toEqual([BAO, KIERA]);
      expect(res.data.failures[0]!.error).toMatch(/already unpaid/i);
      expect(res.data.failures[1]!.error).toMatch(/nothing to reverse/i);
    }
    // The amount stays on the row — only the payment is cleared.
    expect(feeOf(ADA)).toMatchObject({ amount_cents: 3000, paid_at: null, marked_by: null, method: null });
    // ONE audit row, not three.
    expect(auditsOf('fee_marked_unpaid')).toHaveLength(1);
    expect(store.sentry).toEqual([]);
  });

  it('asks for the same capability each single-record action asks for', async () => {
    store.gateCalls = [];
    await bulkMarkFeesPaid([ADA], SEASON);
    expect(new Set(store.gateCalls)).toEqual(new Set(['fees.clubfees.markpaid.write']));

    store.gateCalls = [];
    await bulkWaiveFees([BAO], SEASON);
    expect(new Set(store.gateCalls)).toEqual(new Set(['fees.clubfees.waive.write']));

    store.gateCalls = [];
    await bulkMarkFeesUnpaid([ADA], SEASON);
    expect(new Set(store.gateCalls)).toEqual(new Set(['fees.clubfees.markunpaid.write']));
  });

  it('writes nothing at all for an officer without the capability', async () => {
    store.gateError = 'Admin or exec access required';

    const res = await bulkMarkFeesPaid([ADA, BAO], SEASON, 'cash');

    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/access required/i);
    expect(store.db.club_fees).toEqual([]);
    expect(auditsOf('fee_marked_paid')).toHaveLength(0);
  });

  it('records a repeated id once', async () => {
    const res = await bulkMarkFeesPaid([ADA, ADA], SEASON);

    expect(res.ok).toBe(true);
    if (res.ok) expect(res.data.attempted).toBe(1);
    expect(feesOf(ADA)).toHaveLength(1);
    expect(auditsOf('fee_marked_paid')).toHaveLength(1);
  });

  it('refuses a list longer than one request may act on, before the gate', async () => {
    // Reached only by a hand-rolled POST — the console chunks at BULK_CHUNK.
    const many = Array.from({ length: MAX_BULK_TARGETS + 1 }, (_, i) => `p${i}`);
    const res = await bulkWaiveFees(many, SEASON);

    expect(res.ok).toBe(false);
    expect(store.db.club_fees).toEqual([]);
    expect(store.gateCalls).toEqual([]);
  });
});

describe('the entry fee, over a selection', () => {
  beforeEach(() => {
    (store.db.players ??= []).push(
      { id: ADA, full_name: 'Ada Chen', status: 'competitive', membership_type: 'internal' },
      { id: BAO, full_name: 'Bao Nguyen', status: 'recreational', membership_type: 'external' },
      { id: KIERA, full_name: 'Kiera Wong', status: 'competitive', membership_type: 'internal' },
    );
    store.db.tournaments = [{ id: TOURNAMENT, season_id: SEASON }];
    // A DEFAULT TIER PRICED AT NEITHER of the two rows below, so a re-derivation
    // from the tier list is visible rather than plausible. ensureEntryFees seeds
    // each row from the member's REAL tier; the default is the $25-external trap
    // e6f71300 closed.
    store.db.tournament_fee_tiers = [
      { id: 'tier-default', tournament_id: TOURNAMENT, amount_cents: 9999, is_default: true },
    ];
    store.db.club_fees = [
      { id: 'entry-ada', tournament_id: TOURNAMENT, player_id: ADA, fee_type: 'tournament', tier_id: 'tier-internal', amount_cents: 1500, paid_at: null, marked_by: null, method: null, reference: null },
      { id: 'entry-bao', tournament_id: TOURNAMENT, player_id: BAO, fee_type: 'tournament', tier_id: 'tier-external', amount_cents: 2500, paid_at: null, marked_by: null, method: null, reference: null },
    ];
  });

  it('keeps each entrant\'s own snapshot price, because neither an amount nor a tier is passed', async () => {
    // The entry-fee half of the claim above. Two rows at two prices, settled in
    // one call, with a default tier sitting there at $99.99: if the wrapper sent
    // a tier or an amount — or if the action re-derived one — both rows would
    // come back the same figure and the audit entries would agree with it.
    const res = await bulkMarkTournamentFeesPaid([ADA, BAO], TOURNAMENT, 'cash', 'reg-desk');

    expect(res.ok).toBe(true);
    if (res.ok) expect(res.data).toMatchObject({ attempted: 2, succeeded: 2, failures: [] });
    expect(feeOf(ADA)).toMatchObject({ amount_cents: 1500, tier_id: 'tier-internal', method: 'cash', reference: 'reg-desk' });
    expect(feeOf(BAO)).toMatchObject({ amount_cents: 2500, tier_id: 'tier-external', method: 'cash', reference: 'reg-desk' });
    expect(auditsOf('tournament_fee_marked_paid')).toHaveLength(2);
  });

  it('refuses an entrant who has already paid, and records the rest', async () => {
    feeOf(ADA)!.paid_at = '2026-09-01T00:00:00.000Z';
    feeOf(ADA)!.method = 'transfer';

    const res = await bulkMarkTournamentFeesPaid([ADA, BAO], TOURNAMENT, 'cash');

    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.data.succeeded).toBe(1);
      expect(res.data.failures[0]!.id).toBe(ADA);
      expect(res.data.failures[0]!.error).toMatch(/already recorded as paid/i);
    }
    expect(feeOf(ADA)).toMatchObject({ method: 'transfer', amount_cents: 1500 });
    expect(feeOf(BAO)).toMatchObject({ method: 'cash' });
    expect(auditsOf('tournament_fee_marked_paid')).toHaveLength(1);
    expect(store.sentry).toEqual([]);
  });

  it('reverses a payment, and refuses both an already-unpaid row and an entrant with no row', async () => {
    // markTournamentFeeUnpaid was a line-for-line mirror of markFeeUnpaid BEFORE
    // e6f71300 fixed it: a member with no row threw a plain Error that Sentry
    // filed as a defect, and an already-unpaid row cleared three already-null
    // fields and filed an audit entry for a reversal that reversed nothing. Both
    // assertions below fail on that code.
    feeOf(ADA)!.paid_at = '2026-09-01T00:00:00.000Z';
    feeOf(ADA)!.marked_by = 'exec-0';
    feeOf(ADA)!.method = 'cash';

    const res = await bulkMarkTournamentFeesUnpaid([ADA, BAO, KIERA], TOURNAMENT);

    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.data.succeeded).toBe(1);
      expect(res.data.failures.map((f) => f.id)).toEqual([BAO, KIERA]);
      expect(res.data.failures[0]!.error).toMatch(/already unpaid/i);
      expect(res.data.failures[1]!.error).toMatch(/nothing to reverse/i);
    }
    // The entry stays on the books, priced, with only the payment cleared.
    expect(feeOf(ADA)).toMatchObject({ amount_cents: 1500, paid_at: null, marked_by: null, method: null });
    // ONE audit row, not three. This is the assertion that catches the vacuous
    // reversal specifically.
    expect(auditsOf('tournament_fee_marked_unpaid')).toHaveLength(1);
    // And neither refusal is a fault: both are ExpectedError now.
    expect(store.sentry).toEqual([]);
  });

  it('files a reversal for an entrant with no row as a refusal, not as a fault', async () => {
    // ON ITS OWN, deliberately. The test above asserts the same two things, but
    // its first expectation (`succeeded` is 1) is what fails on the pre-e6f71300
    // mirror, so it aborts before reaching either of these — and an assertion
    // never reached against unfixed code has not been checked. KIERA is entered
    // and carries no club_fees row at all.
    //
    // A plain Error whose message is not in EXPECTED_DB_GUARDS is filed as a
    // fault, so this one refusal, looped over a roster, pages somebody per row.
    const res = await bulkMarkTournamentFeesUnpaid([KIERA], TOURNAMENT);

    // Sentry FIRST, because that is the defect: the refusal itself was always
    // reported to the caller, it was the paging that was wrong.
    expect(store.sentry).toEqual([]);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.data).toMatchObject({ attempted: 1, succeeded: 0 });
      expect(res.data.failures[0]!.error).toMatch(/nothing to reverse/i);
    }
    expect(auditsOf('tournament_fee_marked_unpaid')).toHaveLength(0);
  });

  it('prices an entrant who has no row at all from the DEFAULT tier — see the note', async () => {
    // A PIN ON CURRENT BEHAVIOUR, NOT AN ENDORSEMENT. Every other assertion here
    // runs through a seeded ledger row, which is the case the wrapper's "no
    // amount" comment describes: markTournamentFeePaid keeps the row's own
    // snapshot. KIERA has no row, so there is no snapshot to keep and the action
    // falls through to the tournament's is_default tier — $99.99 here, and on the
    // live tournament the $25 External price for an internal member who owes $15.
    //
    // Her own row's dialog would not do this: it prefills from
    // quoteEntryFee(membership, tiers, null), which asks selectFeeTier for the
    // tier matching HER membership. So bulk and single-row disagree for exactly
    // this entrant, in the shape e6f71300 closed, arriving through the no-row
    // door instead. Reachable because ensureEntryFees never throws (a seed that
    // failed leaves no row) and because entries predate it.
    //
    // Left alone rather than fixed: passing a tier from the bar would mean the
    // client choosing a price, and re-deriving one inside the action is a change
    // to the single-record contract that every existing caller shares. Reported
    // instead.
    const res = await bulkMarkTournamentFeesPaid([KIERA], TOURNAMENT, 'cash');

    expect(res.ok).toBe(true);
    if (res.ok) expect(res.data).toMatchObject({ attempted: 1, succeeded: 1 });
    expect(feeOf(KIERA)).toMatchObject({ amount_cents: 9999, tier_id: 'tier-default', method: 'cash' });
  });

  it('asks for the same capability each single-record action asks for', async () => {
    store.gateCalls = [];
    await bulkMarkTournamentFeesPaid([ADA], TOURNAMENT);
    expect(new Set(store.gateCalls)).toEqual(new Set(['tournaments.fees.markpaid.write']));

    store.gateCalls = [];
    await bulkMarkTournamentFeesUnpaid([ADA], TOURNAMENT);
    expect(new Set(store.gateCalls)).toEqual(new Set(['tournaments.fees.markunpaid.write']));
  });

  it('writes nothing at all for an officer without the capability', async () => {
    store.gateError = 'Admin or exec access required';

    const res = await bulkMarkTournamentFeesPaid([ADA, BAO], TOURNAMENT, 'cash');

    expect(res.ok).toBe(false);
    expect(feeOf(ADA)!.paid_at).toBeNull();
    expect(feeOf(BAO)!.paid_at).toBeNull();
    expect(auditsOf('tournament_fee_marked_paid')).toHaveLength(0);
  });
});
