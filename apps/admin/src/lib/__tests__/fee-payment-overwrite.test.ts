import { describe, it, expect, beforeEach, vi } from 'vitest';

// MARKING A FEE PAID MUST NOT SILENTLY REWRITE A PAYMENT THAT WAS ALREADY TAKEN.
//
// waiveFee has a long comment about this and a guard to match: it names a
// fee_waived row on production whose old_value is empty, because the write
// replaced a real amount with $0 and the audit entry kept no copy of what had
// been there. The two mark-paid actions were the same defect and had neither
// half of the fix:
//
//   * they read the existing row's `id` alone, updated amount_cents / method /
//     reference / tier_id unconditionally, and audited with no old_value — so a
//     $100 dues row rewritten as $80, or a $25 door price rewritten as the $15
//     member tier, lost the original figure in the ledger AND in the log;
//   * the UPDATE carried no predicate, so two desks working the same roster both
//     read an unpaid row and the second write landed on top of the first.
//
// Both are covered here for BOTH ledgers — club dues (actions/fees.ts) and
// tournament entry fees (actions/tournament-fees.ts) — because they are the same
// three lines over the same table and only the tournament one was reported.
//
// The assertions are on the SURVIVING ROW and on the audit entry, not on "it
// threw": the point is never to lose the number, and a refusal that still
// overwrote would pass a throw-only test.

type Row = Record<string, unknown>;
type Op = 'select' | 'update' | 'insert';

const store = vi.hoisted(() => ({
  db: {} as Record<string, Row[]>,
  seq: 0,
  /** Runs just before an UPDATE is applied — models another desk winning. */
  beforeUpdate: null as null | ((ctx: { table: string; payload: Row }) => void),
}));

const makeClient = vi.hoisted(() => () => {
  function query(table: string) {
    const filters: Array<[string, unknown]> = [];
    // `.is(col, null)` is a different predicate from `.eq(col, null)` and the
    // guards under test depend on it: it is what makes "only while this row is
    // still unpaid" true in the database rather than only in the read above it.
    const isFilters: Array<[string, unknown]> = [];
    let op: Op = 'select';
    let payload: Row = {};

    const matching = () =>
      (store.db[table] ?? []).filter(
        (r) =>
          filters.every(([c, v]) => r[c] === v) &&
          isFilters.every(([c, v]) => (v === null ? r[c] == null : r[c] === v)),
      );

    const run = (): { data: Row[] | null; error: { message: string } | null } => {
      if (op === 'insert') {
        const row = { id: `00000000-0000-4000-8000-${String(++store.seq).padStart(12, '0')}`, ...payload };
        (store.db[table] ??= []).push(row);
        return { data: [row], error: null };
      }
      if (op === 'update') {
        store.beforeUpdate?.({ table, payload });
        const hit = matching();
        for (const r of hit) Object.assign(r, payload);
        return { data: hit.map((r) => ({ ...r })), error: null };
      }
      // DETACHED COPIES, because PostgREST returns JSON and not a live handle on
      // the row. Returning the stored object would let the UPDATE below mutate
      // the snapshot the action is holding for old_value, and the audit
      // assertions in this file would pass against a log entry that recorded the
      // NEW values under the old key — the exact bug they exist to catch.
      return { data: matching().map((r) => ({ ...r })), error: null };
    };

    const api = {
      select() { return api; },
      insert(p: Row) { op = 'insert'; payload = p; return api; },
      update(p: Row) { op = 'update'; payload = p; return api; },
      eq(c: string, v: unknown) { filters.push([c, v]); return api; },
      is(c: string, v: unknown) { isFilters.push([c, v]); return api; },
      async single() {
        const res = run();
        return { data: res.data?.[0] ?? null, error: res.error };
      },
      async maybeSingle() {
        const res = run();
        return { data: res.data?.[0] ?? null, error: res.error };
      },
      then(resolve: (v: unknown) => unknown) { return Promise.resolve(run()).then(resolve); },
    };
    return api;
  }
  return { from: (table: string) => query(table) };
});

vi.mock('next/cache', () => ({ revalidatePath: () => {} }));
vi.mock('@sentry/nextjs', () => ({ captureException: () => {} }));
vi.mock('../supabase-server', () => ({ createAdminClient: makeClient }));
vi.mock('../actions/_shared', () => ({
  requireCapability: async () => ({ id: 'admin-1', role: 'admin' }),
}));
// The REAL logAdminAudit, writing into the same fake db, so the audit row this
// suite asserts on is the row the action actually produces.
vi.mock('../audit', () => ({
  logAdminAudit: async (client: { from: (t: string) => { insert: (r: Row) => unknown } }, entry: Row) => {
    await client.from('audit_logs').insert(entry);
  },
}));

import { markFeePaid } from '../actions/fees';
import { markTournamentFeePaid } from '../actions/tournament-fees';

const TOURNAMENT = '11111111-1111-4111-8111-111111111111';
const PLAYER = '33333333-3333-4333-8333-333333333333';
const SEASON = '99999999-9999-4999-8999-999999999999';
const MEMBER_TIER = '44444444-4444-4444-8444-444444444444';

const duesRow = () => (store.db.club_fees ?? []).find((r) => r.fee_type === 'dues');
const entryRow = () => (store.db.club_fees ?? []).find((r) => r.fee_type === 'tournament');
const auditRows = (type: string) =>
  (store.db.audit_logs ?? []).filter((r) => r.action_type === type);

beforeEach(() => {
  store.seq = 0;
  store.beforeUpdate = null;
  store.db = {
    club_fees: [],
    audit_logs: [],
    players: [{ id: PLAYER, status: 'competitive' }],
    seasons: [{ id: SEASON, competitive_fee_cents: 5000, recreational_fee_cents: 3000 }],
    tournaments: [{ id: TOURNAMENT, season_id: SEASON }],
    tournament_fee_tiers: [
      { id: MEMBER_TIER, tournament_id: TOURNAMENT, name: 'Member', amount_cents: 1500, is_default: true },
    ],
  };
});

/** An unpaid liability, which is what ensureEntryFees files at registration. */
function unpaidEntryFee() {
  store.db.club_fees!.push({
    id: 'fee-entry-1', fee_type: 'tournament', tournament_id: TOURNAMENT,
    player_id: PLAYER, season_id: SEASON, amount_cents: 2500, paid_at: null,
    method: null, reference: null, tier_id: null,
  });
}

function paidEntryFee() {
  store.db.club_fees!.push({
    id: 'fee-entry-1', fee_type: 'tournament', tournament_id: TOURNAMENT,
    player_id: PLAYER, season_id: SEASON, amount_cents: 2500,
    paid_at: '2026-08-01T00:00:00.000Z', method: 'cash', reference: 'door', tier_id: null,
  });
}

function unpaidDues() {
  store.db.club_fees!.push({
    id: 'fee-dues-1', fee_type: 'dues', player_id: PLAYER, season_id: SEASON,
    amount_cents: null, paid_at: null, method: null, reference: null,
  });
}

function paidDues(extra: Row = {}) {
  store.db.club_fees!.push({
    id: 'fee-dues-1', fee_type: 'dues', player_id: PLAYER, season_id: SEASON,
    amount_cents: 10000, paid_at: '2026-08-01T00:00:00.000Z', method: 'cash',
    reference: 'envelope', ...extra,
  });
}

describe('markTournamentFeePaid does not overwrite a recorded payment', () => {
  // The normal path, and it must stay open: ensureEntryFees files the row unpaid
  // at registration, so almost every real call is an UPDATE of an unpaid row.
  it('still records a payment against an unpaid entry-fee row', async () => {
    unpaidEntryFee();

    await markTournamentFeePaid({
      tournament_id: TOURNAMENT, player_id: PLAYER, amount_cents: 2500, method: 'cash',
    });

    expect(entryRow()!.paid_at).toBeTruthy();
    expect(entryRow()!.amount_cents).toBe(2500);
  });

  // THE REPORTED DEFECT. $25 taken at the door, then a second Mark Paid falling
  // back to the $15 member tier: the old code reported success and the $25 was
  // gone from the ledger and absent from the audit log.
  it('refuses a second payment and leaves the recorded amount untouched', async () => {
    paidEntryFee();

    await expect(
      markTournamentFeePaid({ tournament_id: TOURNAMENT, player_id: PLAYER, tier_id: MEMBER_TIER }),
    ).rejects.toThrow(/already recorded as paid/i);

    expect(entryRow()!.amount_cents).toBe(2500);
    expect(entryRow()!.method).toBe('cash');
    expect(entryRow()!.paid_at).toBe('2026-08-01T00:00:00.000Z');
    // And no audit row claiming a payment that did not happen.
    expect(auditRows('tournament_fee_marked_paid')).toHaveLength(0);
  });

  // The refusal above read a row that was unpaid a moment ago. Without the
  // `.is('paid_at', null)` on the UPDATE the loser of the race overwrites the
  // winner's figure and is told it worked.
  it('loses the race without overwriting when another desk pays first', async () => {
    unpaidEntryFee();
    store.beforeUpdate = ({ table }) => {
      if (table !== 'club_fees') return;
      store.beforeUpdate = null;
      const row = entryRow()!;
      row.paid_at = '2026-08-02T00:00:00.000Z';
      row.amount_cents = 2500;
      row.method = 'e-transfer';
    };

    await expect(
      markTournamentFeePaid({ tournament_id: TOURNAMENT, player_id: PLAYER, amount_cents: 1500 }),
    ).rejects.toThrow(/another desk/i);

    expect(entryRow()!.amount_cents).toBe(2500);
    expect(entryRow()!.method).toBe('e-transfer');
    expect(auditRows('tournament_fee_marked_paid')).toHaveLength(0);
  });

  // Even when nothing is destroyed, the previous state has to be recoverable —
  // that is the half of waiveFee's incident that the guard alone does not fix.
  it('audits the previous row so the figure is recoverable', async () => {
    unpaidEntryFee();

    await markTournamentFeePaid({
      tournament_id: TOURNAMENT, player_id: PLAYER, amount_cents: 1500, method: 'cash',
    });

    const [entry] = auditRows('tournament_fee_marked_paid');
    expect(entry).toBeTruthy();
    expect((entry!.old_value as Row).amount_cents).toBe(2500);
    expect((entry!.old_value as Row).paid_at).toBeNull();
  });

  it('records a fee that had no row at all, with a null old_value', async () => {
    await markTournamentFeePaid({
      tournament_id: TOURNAMENT, player_id: PLAYER, amount_cents: 1500,
    });

    expect(entryRow()!.amount_cents).toBe(1500);
    expect(auditRows('tournament_fee_marked_paid')[0]!.old_value).toBeNull();
  });
});

describe('markFeePaid does not overwrite a recorded payment', () => {
  it('still records a payment against an unpaid dues row', async () => {
    unpaidDues();

    await markFeePaid({ player_id: PLAYER, season_id: SEASON, amount_cents: 5000, method: 'cash' });

    expect(duesRow()!.paid_at).toBeTruthy();
    expect(duesRow()!.amount_cents).toBe(5000);
  });

  // The twin of the reported defect, in the file whose own waiveFee comment
  // describes it. $100 collected, re-marked at the season's $50 rate.
  it('refuses a second payment and leaves the recorded amount untouched', async () => {
    paidDues();

    await expect(
      markFeePaid({ player_id: PLAYER, season_id: SEASON }),
    ).rejects.toThrow(/already recorded as paid \(\$100\.00\)/i);

    expect(duesRow()!.amount_cents).toBe(10000);
    expect(duesRow()!.method).toBe('cash');
    expect(auditRows('fee_marked_paid')).toHaveLength(0);
  });

  // A waiver is a paid row with amount_cents 0 and method 'waived'. waiveFee may
  // re-waive one because that destroys nothing; recording a PAYMENT over one
  // replaces the club's decision not to charge, which is a fact of its own.
  it('refuses to record a payment over a waived fee, and says it is waived', async () => {
    paidDues({ amount_cents: 0, method: 'waived', reference: null });

    await expect(
      markFeePaid({ player_id: PLAYER, season_id: SEASON, amount_cents: 5000 }),
    ).rejects.toThrow(/already recorded as waived/i);

    expect(duesRow()!.method).toBe('waived');
    expect(duesRow()!.amount_cents).toBe(0);
  });

  it('loses the race without overwriting when another desk pays first', async () => {
    unpaidDues();
    store.beforeUpdate = ({ table }) => {
      if (table !== 'club_fees') return;
      store.beforeUpdate = null;
      const row = duesRow()!;
      row.paid_at = '2026-08-02T00:00:00.000Z';
      row.amount_cents = 10000;
    };

    await expect(
      markFeePaid({ player_id: PLAYER, season_id: SEASON, amount_cents: 5000 }),
    ).rejects.toThrow(/another desk/i);

    expect(duesRow()!.amount_cents).toBe(10000);
    expect(auditRows('fee_marked_paid')).toHaveLength(0);
  });

  it('audits the previous row so the figure is recoverable', async () => {
    unpaidDues();

    await markFeePaid({ player_id: PLAYER, season_id: SEASON, amount_cents: 5000 });

    const [entry] = auditRows('fee_marked_paid');
    expect(entry).toBeTruthy();
    expect((entry!.old_value as Row).paid_at).toBeNull();
    expect((entry!.old_value as Row).id).toBe('fee-dues-1');
  });
});
