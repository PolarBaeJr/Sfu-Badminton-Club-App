import { describe, it, expect, beforeEach, vi } from 'vitest';

// The two non-fee money ledgers (00073): other income in, club expenses out.
//
// Three things can go wrong with a money action and every one of them is silent
// in production, so each is pinned here:
//   1. someone who is not an admin writes to the ledger;
//   2. a delete "succeeds" against a row that was not there, because PostgREST
//      reports "matched no rows" as success;
//   3. money moves with nobody's name attached, because the audit write was
//      forgotten or was given the destroyed row too late to record it.

type Row = Record<string, unknown>;
type Op = 'select' | 'insert' | 'delete';

const store = vi.hoisted(() => ({
  db: {} as Record<string, Row[]>,
  seq: 0,
  actor: { id: 'admin-1', role: 'admin' } as { id: string; role: string; is_exec?: boolean },
  /** Makes the next delete match nothing, without removing the row. */
  swallowDeletes: false,
}));

const makeClient = vi.hoisted(() => () => {
  function query(table: string) {
    const filters: Array<[string, unknown]> = [];
    let op: Op = 'select';
    let payload: Row = {};
    let selected = false;

    const matching = () => (store.db[table] ?? []).filter((r) => filters.every(([c, v]) => r[c] === v));

    const run = (): { data: Row[] | null; error: { message: string } | null } => {
      if (op === 'insert') {
        const row = { id: `00000000-0000-4000-8000-${String(++store.seq).padStart(12, '0')}`, ...payload };
        (store.db[table] ??= []).push(row);
        return { data: [row], error: null };
      }
      if (op === 'delete') {
        // The heart of the guard under test: PostgREST returns `error: null`
        // and an EMPTY array when the filter matched nothing. Success and
        // "there was nothing there" are the same response.
        if (store.swallowDeletes) return { data: [], error: null };
        const hit = matching();
        store.db[table] = (store.db[table] ?? []).filter((r) => !hit.includes(r));
        // `.select()` is what makes the deleted rows come back at all. Without
        // it PostgREST returns no rows even on a successful delete, so a caller
        // that skipped it could never tell the two apart.
        return { data: selected ? hit : [], error: null };
      }
      return { data: matching(), error: null };
    };

    const api = {
      select() { selected = true; return api; },
      insert(p: Row) { op = 'insert'; payload = p; return api; },
      delete() { op = 'delete'; return api; },
      eq(c: string, v: unknown) { filters.push([c, v]); return api; },
      async single() {
        const res = run();
        return res.error ? { data: null, error: res.error } : { data: res.data?.[0] ?? null, error: null };
      },
      async maybeSingle() {
        const res = run();
        return res.error ? { data: null, error: res.error } : { data: res.data?.[0] ?? null, error: null };
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
// Modelled on the real gates: getAdminPlayer rejects anyone who is not an
// admin, including an exec. Which gate an action calls is the entire access
// story, because createAdminClient() is service-role and bypasses RLS.
vi.mock('../actions/_shared', () => ({
  getExecOrAdmin: async () => store.actor,
  getAdminPlayer: async () => {
    if (store.actor.role !== 'admin') throw new Error('Admin access required');
    return store.actor;
  },
}));

import { addOtherIncome, removeOtherIncome, addExpense, removeExpense } from '../actions/finance';

const SEASON = '22222222-2222-4222-8222-222222222222';
const ADMIN = { id: 'admin-1', role: 'admin' };
const EXEC = { id: 'exec-1', role: 'player', is_exec: true };

const income = () => store.db.other_income ?? [];
const expenses = () => store.db.club_expenses ?? [];
const audits = () => store.db.audit_logs ?? [];

beforeEach(() => {
  store.seq = 0;
  store.actor = { ...ADMIN };
  store.swallowDeletes = false;
  store.db = { other_income: [], club_expenses: [], audit_logs: [], seasons: [{ id: SEASON, active_flag: true }] };
});

describe('addOtherIncome / addExpense', () => {
  it('records an entry against the season it was given', async () => {
    await addOtherIncome({
      season_id: SEASON,
      category: 'donation',
      description: 'Alumni donation',
      amount_cents: 15000,
    });

    expect(income()).toHaveLength(1);
    expect(income()[0]!.season_id).toBe(SEASON);
    expect(income()[0]!.amount_cents).toBe(15000);
  });

  // The season is a COLUMN, set from what the caller passed, and no code path
  // derives it from a date. reinstatement_fees was bucketed by paid_at and a
  // $20 payment taken three weeks before its term began fell outside every
  // window and appeared in no total (00069). An expense dated outside the
  // season must still count toward the season it was recorded under.
  it('keeps a back-dated expense in its season', async () => {
    await addExpense({
      season_id: SEASON,
      category: 'shuttles',
      description: 'Pre-season shuttle order',
      amount_cents: 8400,
      paid_at: '2026-08-01T12:00:00.000Z',
    });

    expect(expenses()[0]!.season_id).toBe(SEASON);
    expect(expenses()[0]!.paid_at).toBe('2026-08-01T12:00:00.000Z');
  });

  // paid_at is what makes a row count toward a total. Leaving it null on an
  // ordinary entry would file real money into a row every sum ignores, so the
  // action stamps it when the caller gives no date.
  it('stamps paid_at when no date is given, so the row is counted', async () => {
    await addExpense({
      season_id: SEASON,
      category: 'food',
      description: 'Social pizza',
      amount_cents: 6000,
    });

    expect(expenses()[0]!.paid_at).toBeTruthy();
  });

  it('records who entered it', async () => {
    await addExpense({ season_id: SEASON, category: 'equipment', description: 'Net', amount_cents: 4000 });
    expect(expenses()[0]!.marked_by).toBe(ADMIN.id);
  });

  // Money moving with nobody's name on it is what an audit trail exists for.
  it('audits both ledgers', async () => {
    await addOtherIncome({ season_id: SEASON, category: 'grant', description: 'SFSS grant', amount_cents: 50000 });
    await addExpense({ season_id: SEASON, category: 'court_rental', description: 'Gym block', amount_cents: 30000 });

    expect(audits().map((a) => a.action_type)).toEqual(['other_income_added', 'expense_added']);
  });

  // /fees is admin-level in permissions.ts, but middleware is not the boundary:
  // these actions run with a service-role client that bypasses RLS entirely, so
  // an ungated action would be an open write endpoint regardless of the route
  // map. An exec runs the club and may lift a ban; they may not touch money.
  it('refuses an exec on every mutation', async () => {
    store.actor = { ...EXEC };

    await expect(addOtherIncome({ season_id: SEASON, category: 'donation', description: 'x', amount_cents: 100 }))
      .rejects.toThrow(/Admin access required/);
    await expect(addExpense({ season_id: SEASON, category: 'shuttles', description: 'x', amount_cents: 100 }))
      .rejects.toThrow(/Admin access required/);
    await expect(removeOtherIncome('00000000-0000-4000-8000-000000000001'))
      .rejects.toThrow(/Admin access required/);
    await expect(removeExpense('00000000-0000-4000-8000-000000000001'))
      .rejects.toThrow(/Admin access required/);

    expect(income()).toHaveLength(0);
    expect(expenses()).toHaveLength(0);
  });

  // Validation runs before the write. A blank description makes a ledger line
  // nobody can identify a year later, and a fractional cent is not money.
  it('rejects an entry with no description', async () => {
    await expect(addExpense({ season_id: SEASON, category: 'shuttles', description: '   ', amount_cents: 100 }))
      .rejects.toThrow();
    expect(expenses()).toHaveLength(0);
  });
});

describe('removeOtherIncome / removeExpense', () => {
  it('deletes the row and audits what was destroyed', async () => {
    await addExpense({ season_id: SEASON, category: 'shuttles', description: '6 tubes', amount_cents: 8400 });
    const id = expenses()[0]!.id as string;

    await removeExpense(id);

    expect(expenses()).toHaveLength(0);
    const entry = audits().find((a) => a.action_type === 'expense_removed')!;
    // old_value read BEFORE the delete: afterwards there is nothing left to
    // read, and an audit row that records only "an expense was deleted" cannot
    // answer which one or for how much. There is a fee_waived row on production
    // with an empty old_value for exactly this reason.
    expect((entry.old_value as Row).amount_cents).toBe(8400);
  });

  // THE ONE THIS FILE EXISTS FOR. PostgREST reports a delete that matched no
  // rows as a success — `error` is null and the row array is empty — so a guard
  // that only checks `error` reports "Deleted" for a row that is still there,
  // or for one somebody else already removed. Several bugs shipped this way.
  it('refuses to report success when the delete matched nothing', async () => {
    await addExpense({ season_id: SEASON, category: 'shuttles', description: '6 tubes', amount_cents: 8400 });
    const id = expenses()[0]!.id as string;
    store.swallowDeletes = true;

    await expect(removeExpense(id)).rejects.toThrow(/not deleted/i);
    // And nothing is written to the audit log claiming it went.
    expect(audits().some((a) => a.action_type === 'expense_removed')).toBe(false);
  });

  it('refuses to report success when an income delete matched nothing', async () => {
    await addOtherIncome({ season_id: SEASON, category: 'donation', description: 'Alumni', amount_cents: 15000 });
    const id = income()[0]!.id as string;
    store.swallowDeletes = true;

    await expect(removeOtherIncome(id)).rejects.toThrow(/not deleted/i);
    expect(audits().some((a) => a.action_type === 'other_income_removed')).toBe(false);
  });

  // A delete of an id that never existed must not be reported as a deletion
  // either — same failure, one step earlier.
  it('rejects an unknown id instead of silently doing nothing', async () => {
    await expect(removeExpense('00000000-0000-4000-8000-000000009999')).rejects.toThrow(/not found/i);
    await expect(removeOtherIncome('00000000-0000-4000-8000-000000009999')).rejects.toThrow(/not found/i);
  });
});
