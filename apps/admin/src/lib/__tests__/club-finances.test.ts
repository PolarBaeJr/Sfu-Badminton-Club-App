import { describe, it, expect, beforeEach, vi } from 'vitest';

// The two non-fee money ledgers (00073): other income in, club expenses out —
// plus reimbursement of whoever fronted an expense (00077).
//
// Four things can go wrong with a money action and every one of them is silent
// in production, so each is pinned here:
//   1. someone writes to a ledger they are not allowed to write to — which is
//      now a per-ACTION question, not a per-file one: an exec may add an
//      expense and may do nothing else here;
//   2. a delete or an update "succeeds" against a row that was not there,
//      because PostgREST reports "matched no rows" as success;
//   3. money moves with nobody's name attached, because the audit write was
//      forgotten or was given the destroyed row too late to record it;
//   4. the wrong person is recorded as being owed money, because the payer was
//      taken from whoever typed the row instead of being asked for.

type Row = Record<string, unknown>;
type Op = 'select' | 'insert' | 'update' | 'delete';

const store = vi.hoisted(() => ({
  db: {} as Record<string, Row[]>,
  seq: 0,
  actor: { id: 'admin-1', role: 'admin' } as { id: string; role: string; is_exec?: boolean },
  /** Makes the next delete match nothing, without removing the row. */
  swallowDeletes: false,
  /** Same, for updates: PostgREST cannot tell "matched nothing" from success. */
  swallowUpdates: false,
}));

const makeClient = vi.hoisted(() => () => {
  function query(table: string) {
    const filters: Array<[string, unknown]> = [];
    let op: Op = 'select';
    let payload: Row = {};
    let selected = false;

    // `.is(col, null)` in PostgREST means SQL NULL. In this in-memory store a
    // column that was never written is `undefined` and one written as NULL is
    // `null`, and both are the same thing in Postgres — so the null filter has
    // to accept either. Plain `===` would make `.is('reimbursed_at', null)`
    // match no rows at all and the reimbursement tests would pass for the wrong
    // reason.
    const NULLISH = Symbol('is-null');
    const matching = () =>
      (store.db[table] ?? []).filter((r) =>
        filters.every(([c, v]) => (v === NULLISH ? r[c] == null : r[c] === v)),
      );

    const run = (): { data: Row[] | null; error: { message: string } | null } => {
      if (op === 'insert') {
        const row = { id: `00000000-0000-4000-8000-${String(++store.seq).padStart(12, '0')}`, ...payload };
        (store.db[table] ??= []).push(row);
        return { data: [row], error: null };
      }
      if (op === 'update') {
        // Same trap as the delete below, and the one that matters most for
        // reimbursement: an update whose filters matched nothing comes back
        // with error null and an empty array, identical to a real write.
        if (store.swallowUpdates) return { data: [], error: null };
        const hit = matching();
        for (const row of hit) Object.assign(row, payload);
        return { data: selected ? hit : [], error: null };
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
      // COPIES, not the stored objects. PostgREST hands back parsed JSON, so a
      // row an action read earlier cannot change under it when the row is later
      // updated. Returning the live objects here would make every "audit the
      // old value" assertion pass against the NEW value and hide exactly the
      // bug those assertions exist to catch.
      return { data: matching().map((r) => ({ ...r })), error: null };
    };

    const api = {
      select() { selected = true; return api; },
      insert(p: Row) { op = 'insert'; payload = p; return api; },
      update(p: Row) { op = 'update'; payload = p; return api; },
      delete() { op = 'delete'; return api; },
      eq(c: string, v: unknown) { filters.push([c, v]); return api; },
      // `.is(col, null)` is load-bearing, not incidental: it is what makes
      // marking an already-reimbursed row match zero rows instead of silently
      // re-dating a settlement that happened weeks ago.
      is(c: string, v: unknown) { filters.push([c, v === null ? NULLISH : v]); return api; },
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
// admin, including an exec; getExecOrAdmin admits both and nobody else. WHICH
// GATE AN ACTION CALLS IS THE ENTIRE ACCESS STORY, because createAdminClient()
// is service-role and bypasses RLS — the route map only decides who may open a
// page, and a server action can be invoked without ever loading one.
vi.mock('../actions/_shared', () => ({
  getExecOrAdmin: async () => {
    if (store.actor.role !== 'admin' && !store.actor.is_exec) {
      throw new Error('Exec or admin access required');
    }
    return store.actor;
  },
  getAdminPlayer: async () => {
    if (store.actor.role !== 'admin') throw new Error('Admin access required');
    return store.actor;
  },
}));

import {
  addOtherIncome,
  removeOtherIncome,
  addExpense,
  updateExpense,
  removeExpense,
  markExpenseReimbursed,
} from '../actions/finance';

const SEASON = '22222222-2222-4222-8222-222222222222';
const ADMIN = { id: 'admin-1', role: 'admin' };
// Real uuids, unlike the actor ids above: paid_by is validated as a uuid before
// the write, so a placeholder string would fail validation and the access-check
// assertions would pass for the wrong reason.
const EXEC = { id: '44444444-4444-4444-8444-444444444444', role: 'player', is_exec: true };
const OTHER_EXEC = '33333333-3333-4333-8333-333333333333';

const income = () => store.db.other_income ?? [];
const expenses = () => store.db.club_expenses ?? [];
const audits = () => store.db.audit_logs ?? [];

/** An expense in the store, plus its id, for the tests that act on one. */
async function recordExpense(over: Partial<Record<string, unknown>> = {}) {
  await addExpense({
    season_id: SEASON,
    category: 'shuttles',
    description: '6 tubes',
    amount_cents: 8400,
    ...over,
  } as Parameters<typeof addExpense>[0]);
  return expenses()[expenses().length - 1]!.id as string;
}

beforeEach(() => {
  store.seq = 0;
  store.actor = { ...ADMIN };
  store.swallowDeletes = false;
  store.swallowUpdates = false;
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

  // THE ONE THING AN EXEC MAY DO HERE. The club owner asked for it by name:
  // "allow execs to add expenses too". An exec who buys shuttles at the door
  // has to be able to record it, or the club never learns the money went out
  // and the exec is never paid back.
  it('lets an exec record an expense', async () => {
    store.actor = { ...EXEC };

    await addExpense({ season_id: SEASON, category: 'shuttles', description: '6 tubes', amount_cents: 8400 });

    expect(expenses()).toHaveLength(1);
    expect(expenses()[0]!.marked_by).toBe(EXEC.id);
  });

  // Every OTHER money mutation stays admin-only, and middleware is not what
  // makes it so: these actions run with a service-role client that bypasses RLS
  // entirely, so an ungated action is an open write endpoint regardless of the
  // route map — and a server action can be invoked without ever loading the
  // page it lives on. An exec runs the club and may now record a spend; they
  // may not delete one, may not edit one, may not touch the income ledger, and
  // above all may not confirm their own reimbursement.
  it('refuses an exec everything except adding an expense', async () => {
    // Set up as an admin so there is a real row for the exec to attack.
    const id = await recordExpense({ paid_by: EXEC.id });
    store.actor = { ...EXEC };

    await expect(addOtherIncome({ season_id: SEASON, category: 'donation', description: 'x', amount_cents: 100 }))
      .rejects.toThrow(/Admin access required/);
    await expect(removeOtherIncome('00000000-0000-4000-8000-000000000001'))
      .rejects.toThrow(/Admin access required/);
    await expect(removeExpense(id)).rejects.toThrow(/Admin access required/);
    await expect(updateExpense({ id, category: 'shuttles', description: 'x', amount_cents: 99999 }))
      .rejects.toThrow(/Admin access required/);
    // The one that would actually cost the club money: an exec marking their
    // own out-of-pocket expense as already paid back.
    await expect(markExpenseReimbursed(id)).rejects.toThrow(/Admin access required/);

    expect(income()).toHaveLength(0);
    expect(expenses()).toHaveLength(1);
    expect(expenses()[0]!.amount_cents).toBe(8400);
    expect(expenses()[0]!.reimbursed_at).toBeUndefined();
  });

  // An ordinary member is not a console user at all. getExecOrAdmin() has to
  // reject them, or "execs may add expenses" would read as "anyone may".
  it('refuses a plain member the one action an exec may take', async () => {
    store.actor = { id: 'player-9', role: 'player' };

    await expect(addExpense({ season_id: SEASON, category: 'shuttles', description: 'x', amount_cents: 100 }))
      .rejects.toThrow(/Exec or admin access required/);
    expect(expenses()).toHaveLength(0);
  });

  // paid_by is WHO FRONTED THE MONEY and is taken from the input, never from
  // the actor. The two differ every time an admin writes up an exec's receipt,
  // and deriving it from the actor would file the admin as the person owed —
  // then reimburse them.
  it('records the payer given, not whoever typed the row', async () => {
    await recordExpense({ paid_by: OTHER_EXEC });

    expect(expenses()[0]!.marked_by).toBe(ADMIN.id);
    expect(expenses()[0]!.paid_by).toBe(OTHER_EXEC);
  });

  // No payer means the club account paid directly. It has to be storable as
  // NULL rather than defaulted to somebody, or every club-card purchase would
  // create a phantom debt to a person.
  it('stores no payer at all when the club paid directly', async () => {
    await recordExpense();
    expect(expenses()[0]!.paid_by).toBeNull();
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

describe('markExpenseReimbursed', () => {
  it('records when the club paid the exec back, and which admin confirmed it', async () => {
    const id = await recordExpense({ paid_by: OTHER_EXEC });

    await markExpenseReimbursed(id);

    const row = expenses()[0]!;
    expect(row.reimbursed_at).toBeTruthy();
    expect(row.reimbursed_by).toBe(ADMIN.id);
    // The payer is untouched: who was owed and who confirmed are two facts, and
    // overwriting one with the other is how "reimbursed to the admin who
    // clicked the button" would happen.
    expect(row.paid_by).toBe(OTHER_EXEC);
  });

  // THE ONE THIS BLOCK EXISTS FOR, and the money bug the whole feature risks.
  // PostgREST reports an update that matched NO rows exactly as it reports a
  // successful one: error null, empty array. Without a row-count check an admin
  // is toasted "Marked as reimbursed" for a write that never landed, the exec
  // is told they have been paid, and an audit row is filed swearing to it.
  it('refuses to report success when the update matched nothing', async () => {
    const id = await recordExpense({ paid_by: OTHER_EXEC });
    store.swallowUpdates = true;

    await expect(markExpenseReimbursed(id)).rejects.toThrow(/not marked reimbursed/i);
    expect(audits().some((a) => a.action_type === 'expense_reimbursed')).toBe(false);
  });

  // Nothing to reimburse when the club account paid: marking such a row would
  // assert the club refunded itself, and would show a "Reimbursed" badge for
  // money nobody spent. 00077's club_expenses_reimbursement_needs_payer CHECK
  // is the same rule stated in the database.
  it('refuses a row the club paid for directly', async () => {
    const id = await recordExpense();

    await expect(markExpenseReimbursed(id)).rejects.toThrow(/nobody to reimburse/i);
    expect(expenses()[0]!.reimbursed_at).toBeUndefined();
  });

  // A second click must not silently re-date a settlement that happened weeks
  // ago. The action refuses on the read, and the update's `.is(reimbursed_at,
  // null)` filter refuses again if two admins race.
  it('refuses to re-date an expense that is already reimbursed', async () => {
    const id = await recordExpense({ paid_by: OTHER_EXEC });
    await markExpenseReimbursed(id);
    const first = expenses()[0]!.reimbursed_at;

    await expect(markExpenseReimbursed(id)).rejects.toThrow(/already marked reimbursed/i);
    expect(expenses()[0]!.reimbursed_at).toBe(first);
  });

  it('rejects an unknown id instead of silently doing nothing', async () => {
    await expect(markExpenseReimbursed('00000000-0000-4000-8000-000000009999'))
      .rejects.toThrow(/not found/i);
  });

  // Money moving with nobody's name on it is what the audit trail exists for,
  // and a reimbursement moves real money out of the club account.
  it('audits the settlement with both sides', async () => {
    const id = await recordExpense({ paid_by: OTHER_EXEC });
    await markExpenseReimbursed(id);

    const entry = audits().find((a) => a.action_type === 'expense_reimbursed')!;
    expect(entry.actor_id).toBe(ADMIN.id);
    expect((entry.old_value as Row).amount_cents).toBe(8400);
    expect((entry.new_value as Row).paid_by).toBe(OTHER_EXEC);
  });
});

describe('updateExpense', () => {
  it('corrects a recorded expense and audits both sides', async () => {
    const id = await recordExpense({ paid_by: OTHER_EXEC });

    await updateExpense({
      id,
      category: 'shuttles',
      description: '6 tubes of Yonex AS-30',
      amount_cents: 8900,
    });

    expect(expenses()[0]!.description).toBe('6 tubes of Yonex AS-30');
    expect(expenses()[0]!.amount_cents).toBe(8900);

    // Both values, so a changed FIGURE is reconstructible from the log alone.
    // An audit row that records only "an expense was edited" cannot answer what
    // the amount used to be, which is the only question anyone will ask.
    const entry = audits().find((a) => a.action_type === 'expense_updated')!;
    expect((entry.old_value as Row).amount_cents).toBe(8400);
    expect((entry.new_value as Row).amount_cents).toBe(8900);
  });

  // Same PostgREST trap as the delete and the reimbursement: an update that
  // matched nothing is reported as success, so an admin would be told a
  // corrected amount was saved while the row still holds the old one.
  it('refuses to report success when the update matched nothing', async () => {
    const id = await recordExpense({ paid_by: OTHER_EXEC });
    store.swallowUpdates = true;

    await expect(updateExpense({ id, category: 'shuttles', description: 'x', amount_cents: 1 }))
      .rejects.toThrow(/not updated/i);
    expect(audits().some((a) => a.action_type === 'expense_updated')).toBe(false);
  });

  // THE DECISION THIS FEATURE TURNS ON. Once the club has handed a specific
  // amount to a specific person, that figure is settled. Editing it would leave
  // the row asserting the club reimbursed something it did not — and the badge
  // says so on screen, where nobody cross-checks the audit log. A wrong
  // settlement is a delete-and-re-record, deliberately.
  it('refuses to change the amount of an expense that is already reimbursed', async () => {
    const id = await recordExpense({ paid_by: OTHER_EXEC });
    await markExpenseReimbursed(id);

    await expect(updateExpense({ id, category: 'shuttles', description: '6 tubes', amount_cents: 9900 }))
      .rejects.toThrow(/already been reimbursed/i);
    expect(expenses()[0]!.amount_cents).toBe(8400);
  });

  // And the payer, for the same reason: the club paid THAT person. Repointing
  // it would claim someone was reimbursed who never received anything.
  it('refuses to change the payer of an expense that is already reimbursed', async () => {
    const id = await recordExpense({ paid_by: OTHER_EXEC });
    await markExpenseReimbursed(id);

    await expect(updateExpense({
      id, category: 'shuttles', description: '6 tubes', amount_cents: 8400, paid_by: EXEC.id,
    })).rejects.toThrow(/already been reimbursed/i);
    expect(expenses()[0]!.paid_by).toBe(OTHER_EXEC);
  });

  // The typo case the club owner actually described still works on a settled
  // row. Freezing the whole row would have made the feature useless for the
  // most common edit, and none of these fields change what was paid.
  it('still allows a settled expense to have its description fixed', async () => {
    const id = await recordExpense({ paid_by: OTHER_EXEC });
    await markExpenseReimbursed(id);
    const settledAt = expenses()[0]!.reimbursed_at;

    // paid_by is resent unchanged. The update is a full replacement, exactly as
    // addExpense is, so an omitted payer means "the club paid" — the action
    // refuses that here rather than silently un-assigning the person the club
    // has already reimbursed.
    await updateExpense({
      id,
      category: 'equipment',
      description: 'Shuttle tubes (corrected)',
      amount_cents: 8400,
      paid_by: OTHER_EXEC,
    });

    expect(expenses()[0]!.description).toBe('Shuttle tubes (corrected)');
    expect(expenses()[0]!.category).toBe('equipment');
    // The settlement itself survives untouched — the edit must not clear or
    // re-date it. Clearing was the rejected alternative: the club really did
    // pay that money out, on that date, confirmed by that admin.
    expect(expenses()[0]!.reimbursed_at).toBe(settledAt);
    expect(expenses()[0]!.reimbursed_by).toBe(ADMIN.id);
  });

  // The date is not a field an edit should invent. addExpense stamps paid_at
  // when none is given; doing the same on an edit would silently re-date a
  // September spend to whenever the typo was noticed.
  it('keeps the stored date when the edit carries none', async () => {
    const id = await recordExpense({ paid_at: '2026-09-01T12:00:00.000Z' });

    await updateExpense({ id, category: 'shuttles', description: 'renamed', amount_cents: 8400 });

    expect(expenses()[0]!.paid_at).toBe('2026-09-01T12:00:00.000Z');
  });

  // The reference number is the one thing that must never move: every receipt
  // annotated with it would start pointing at a different row. It is assigned
  // by the database and is not in the update's column list at all. Nor is
  // season_id — moving a spend between seasons changes two net positions in one
  // write, so the schema omits it outright.
  it('never touches the reference number or the season', async () => {
    const id = await recordExpense({ paid_by: OTHER_EXEC });
    // Stands in for what the IDENTITY column does on the real table.
    expenses()[0]!.ref_no = 7;

    await updateExpense({ id, category: 'food', description: 'moved', amount_cents: 100 });

    expect(expenses()[0]!.ref_no).toBe(7);
    expect(expenses()[0]!.season_id).toBe(SEASON);
  });

  it('rejects an unknown id instead of silently doing nothing', async () => {
    await expect(updateExpense({
      id: '00000000-0000-4000-8000-000000009999', category: 'shuttles', description: 'x', amount_cents: 1,
    })).rejects.toThrow(/not found/i);
  });
});
