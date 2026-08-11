import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Capability } from '../permissions';

// An exec may lift a ban; only an admin may touch the money. The unban dialog
// therefore hides the payment fields from execs — and the action used to file
// the reinstatement row with paid_at = now() and amount_cents = null anyway.
// That row claimed a payment had been taken and valued it at nothing, and it
// could never be corrected: reinstatePlayer refuses a second call because the
// member is no longer banned, and club_fees_reinstatement_ban_key (00065, 00094)
// refuses a second row for the same ban. Money received, permanently booked as
// $0, with no edit path anywhere in the console.
//
// These tests pin the two halves of the fix: an unrecorded reinstatement now
// looks unrecorded (null amount AND null paid_at, so season income excludes it
// rather than counting zero), and recordReinstatementPayment is the way back to
// the row afterwards.

type Row = Record<string, unknown>;
type Op = 'select' | 'update' | 'insert';

interface Fault {
  table: string;
  op: Op;
  message: string;
  code?: string;
  /** Narrow the fault to one write, or observe it — see the concurrency test. */
  when?: (ctx: { filters: Array<[string, unknown]>; payload: Row }) => boolean;
}

const store = vi.hoisted(() => ({
  db: {} as Record<string, Row[]>,
  faults: [] as Fault[],
  seq: 0,
  // Who is signed in. Read by the mocked auth helpers below; isAdminActor is
  // NOT mocked, because "is this caller an admin" is the logic under test.
  actor: { id: 'admin-1', role: 'admin' } as { id: string; role: string; is_exec?: boolean },
}));

const makeClient = vi.hoisted(() => () => {
  function query(table: string) {
    const filters: Array<[string, unknown]> = [];
    const isFilters: Array<[string, unknown]> = [];
    let op: Op = 'select';
    let payload: Row = {};

    const matching = () =>
      (store.db[table] ?? []).filter(
        (r) =>
          filters.every(([c, v]) => r[c] === v) &&
          isFilters.every(([c, v]) => (v === null ? r[c] == null : r[c] === v)),
      );

    const fault = () =>
      store.faults.find(
        (f) => f.table === table && f.op === op && (!f.when || f.when({ filters, payload })),
      );

    const run = (): { data: Row[] | null; error: { message: string; code?: string } | null } => {
      const f = fault();
      if (f) return { data: null, error: { message: f.message, code: f.code } };
      if (op === 'insert') {
        // A real uuid, because the actions validate ids with zod before use.
        const row = { id: `00000000-0000-4000-8000-${String(++store.seq).padStart(12, '0')}`, ...payload };
        (store.db[table] ??= []).push(row);
        return { data: [row], error: null };
      }
      if (op === 'update') {
        // `.select()` after an update returns the rows that matched, which is
        // how the action tells "recorded it" from "matched nothing".
        const hit = matching();
        for (const r of hit) Object.assign(r, payload);
        return { data: hit, error: null };
      }
      return { data: matching(), error: null };
    };

    const api = {
      select() { return api; },
      insert(p: Row) { op = 'insert'; payload = p; return api; },
      update(p: Row) { op = 'update'; payload = p; return api; },
      eq(c: string, v: unknown) { filters.push([c, v]); return api; },
      is(c: string, v: unknown) { isFilters.push([c, v]); return api; },
      async single() {
        const res = run();
        if (res.error) return { data: null, error: res.error };
        return { data: res.data?.[0] ?? null, error: null };
      },
      async maybeSingle() {
        const res = run();
        if (res.error) return { data: null, error: res.error };
        return { data: res.data?.[0] ?? null, error: null };
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
// The REAL decision: permits() against the real baselines. Which capability an
// action names is exactly what decides whether an exec can record money —
// players.reinstate.write is in EXEC_BASELINE and fees.reinstatements.write is
// not, and this suite is where that difference is checked.
vi.mock('../actions/_shared', async () => {
  const { accessLevelFor, permits, EXEC_BASELINE, UNRESTRICTED } = await import('../permissions');
  return {
    requireCapability: async (capability: Capability) => {
      if (!permits(accessLevelFor(store.actor), UNRESTRICTED, capability)) {
        // The wording the old two-gate mock used, kept so the assertions below
        // still read as prose. Which of the two you get is now decided by the
        // baseline rather than by which helper the action happened to call.
        throw new Error(
          EXEC_BASELINE.includes(capability)
            ? 'Exec or admin access required'
            : 'Admin access required',
        );
      }
      return store.actor;
    },
  };
});

import { reinstatePlayer, recordReinstatementPayment } from '../actions/reinstatement';

const PLAYER = '11111111-1111-4111-8111-111111111111';
const EXEC = { id: 'exec-1', role: 'player', is_exec: true };
const ADMIN = { id: 'admin-1', role: 'admin' };

// Reinstatements live in club_fees now (00094), tagged fee_type
// 'reinstatement'. Filtering on the tag rather than reading the raw table means
// a row written without it fails these assertions instead of passing them.
const fees = () => (store.db.club_fees ?? []).filter((r) => r.fee_type === 'reinstatement');
const player = () => store.db.players![0]!;

beforeEach(() => {
  store.faults = [];
  store.seq = 0;
  store.actor = { ...ADMIN };
  store.db = {
    players: [{
      id: PLAYER,
      is_banned: true,
      banned_at: '2026-07-01T00:00:00.000Z',
      banned_by: 'admin-1',
      ban_reason: 'Repeated no-shows',
    }],
    seasons: [{ id: 'season-1', active_flag: true }],
    club_fees: [],
    audit_logs: [],
  };
});

describe('reinstatePlayer — what the fee row claims', () => {
  // The reported bug. An exec never sees the payment fields, so nothing is
  // known about the money; the row must say so. Asserting paid_at is null (not
  // merely "a row exists") is the discriminating check — the broken code wrote
  // a row too, it just stamped it paid.
  it('leaves an exec unban unrecorded rather than recorded as $0', async () => {
    store.actor = { ...EXEC };

    await reinstatePlayer({ player_id: PLAYER });

    expect(player().is_banned).toBe(false);
    expect(fees()).toHaveLength(1);
    expect(fees()[0]!.amount_cents).toBeNull();
    // getSeasonIncome counts only rows with paid_at set, so a null here is the
    // difference between "not counted yet" and "counted as nothing".
    expect(fees()[0]!.paid_at).toBeNull();
  });

  // The other side of the same coin: an admin DID see the amount box and left
  // it blank, which the dialog spells out as a free reinstatement. That is a
  // decision, and it must be distinguishable from the exec case above.
  it('records an admin unban with a blank amount as a settled $0', async () => {
    await reinstatePlayer({ player_id: PLAYER });

    expect(fees()[0]!.amount_cents).toBe(0);
    expect(fees()[0]!.paid_at).not.toBeNull();
  });

  it('records the amount an admin does enter', async () => {
    await reinstatePlayer({ player_id: PLAYER, amount_cents: 2000, method: 'etransfer' });

    expect(fees()[0]!.amount_cents).toBe(2000);
    expect(fees()[0]!.method).toBe('etransfer');
  });

  // Pre-existing, deliberate ordering (the ban is lifted BEFORE the fee is
  // written) — kept here because the restructure above could have regressed it
  // without any other test noticing. The bad outcome has to stay "unbanned but
  // the payment was not recorded", never "charged and still banned".
  it('still lifts the ban when the fee row cannot be written', async () => {
    store.faults.push({ table: 'club_fees', op: 'insert', message: 'ledger exploded' });

    await expect(reinstatePlayer({ player_id: PLAYER })).rejects.toThrow();
    expect(player().is_banned).toBe(false);
  });

  it('refuses to reinstate somebody who is not banned', async () => {
    player().is_banned = false;
    await expect(reinstatePlayer({ player_id: PLAYER })).rejects.toThrow(/not banned/i);
    expect(fees()).toHaveLength(0);
  });
});

describe('recordReinstatementPayment', () => {
  async function execUnban() {
    store.actor = { ...EXEC };
    await reinstatePlayer({ player_id: PLAYER });
    store.actor = { ...ADMIN };
    return fees()[0]!.id as string;
  }

  // The whole point: before this action existed, the $20 handed to an exec had
  // nowhere to go. reinstatePlayer refuses to run again (not banned) and 00065
  // refuses a second row for the same ban, so this row was the only target and
  // nothing could write to it.
  it('fills in the money an exec could not record', async () => {
    const feeId = await execUnban();

    await recordReinstatementPayment({ fee_id: feeId, amount_cents: 2000, method: 'etransfer', reference: 'ABC123' });

    expect(fees()[0]!.amount_cents).toBe(2000);
    expect(fees()[0]!.paid_at).not.toBeNull();
    expect(fees()[0]!.method).toBe('etransfer');
    expect(fees()[0]!.reference).toBe('ABC123');
    expect(fees()[0]!.marked_by).toBe('admin-1');
  });

  // Not an editor for money already on the books. A figure that has been
  // recorded is corrected by an admin looking at the audit trail, not
  // overwritten from a list — and $0 counts as recorded.
  it('refuses a second recording', async () => {
    const feeId = await execUnban();
    await recordReinstatementPayment({ fee_id: feeId, amount_cents: 2000 });

    await expect(
      recordReinstatementPayment({ fee_id: feeId, amount_cents: 5000 }),
    ).rejects.toThrow(/already has a recorded amount/i);
    expect(fees()[0]!.amount_cents).toBe(2000);
  });

  // A reinstatement taken between terms has no season (00069 deliberately
  // allows that). Leaving season_id null when the money finally is recorded
  // would reproduce the exact defect 00069 fixed: a real payment in no season's
  // income at all.
  it('stamps the active season onto a reinstatement that had none', async () => {
    const feeId = await execUnban();
    fees()[0]!.season_id = null;

    await recordReinstatementPayment({ fee_id: feeId, amount_cents: 2000 });

    expect(fees()[0]!.season_id).toBe('season-1');
  });

  // But it never moves money between seasons. The payment belongs to the season
  // the reinstatement was granted in, not to whichever season happens to be
  // active when the paperwork catches up.
  it('does not re-bucket a reinstatement that already names a season', async () => {
    const feeId = await execUnban();
    fees()[0]!.season_id = 'season-old';

    await recordReinstatementPayment({ fee_id: feeId, amount_cents: 2000 });

    expect(fees()[0]!.season_id).toBe('season-old');
  });

  // The capability that keeps the exec/admin split intact: recording money is
  // admin work, so this action asks for fees.reinstatements.write, which is not
  // in EXEC_BASELINE — unlike players.reinstate.write, which is.
  it('is closed to execs', async () => {
    const feeId = await execUnban();
    store.actor = { ...EXEC };

    await expect(
      recordReinstatementPayment({ fee_id: feeId, amount_cents: 2000 }),
    ).rejects.toThrow(/admin/i);
    expect(fees()[0]!.amount_cents).toBeNull();
  });

  // Two admins with the payment dialog open. Both read a null amount, so the
  // read-time check clears both; the `.is('amount_cents', null)` filter is what
  // separates them. Matching zero rows is not an error in PostgREST, so without
  // a row-count check the loser was told the payment was recorded and the audit
  // log gained an entry for an amount the ledger does not hold.
  it('tells the loser of a concurrent recording that it did not take', async () => {
    const feeId = await execUnban();
    const before = fees().length;

    // Stand in for the other admin committing first, between this call's read
    // and its guarded update.
    store.faults.push({
      table: 'club_fees',
      op: 'update',
      when: () => {
        fees()[0]!.amount_cents = 2000;
        return false;
      },
      message: 'never fires — this fault only observes',
    });

    await expect(
      recordReinstatementPayment({ fee_id: feeId, amount_cents: 5000 }),
    ).rejects.toThrow(/somebody else recorded/i);

    expect(fees()[0]!.amount_cents).toBe(2000);
    expect(fees()).toHaveLength(before);
  });

  it('rejects a reinstatement that no longer exists', async () => {
    await expect(
      recordReinstatementPayment({ fee_id: '99999999-9999-4999-8999-999999999999', amount_cents: 2000 }),
    ).rejects.toThrow(/no longer exists/i);
  });
});
