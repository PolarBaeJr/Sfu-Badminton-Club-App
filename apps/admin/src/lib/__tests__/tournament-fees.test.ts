import { describe, it, expect, beforeEach, vi } from 'vitest';

// Two defects, both in the same file, both about a write that looked local and
// was not:
//
//   * Creating or renaming a default fee tier cleared the tournament's existing
//     default in a separate committed statement BEFORE attempting the write
//     that could fail. A name collision therefore reported failure and left the
//     tournament with no default tier — after which unlisted players price at
//     nothing and markTournamentFeePaid snapshots a null amount.
//
//   * markTournamentFeePaid looked a fee tier up by id alone. tournament_fees
//     .tier_id is a plain FK to tournament_fee_tiers(id) (00001), so a tier
//     belonging to a different tournament is a valid row as far as Postgres is
//     concerned, and the wrong price was copied onto the wrong tournament.
//
// The assertions below are on the surviving rows, not on "it threw": the broken
// code threw in the collision cases too, it just did damage on the way out.

type Row = Record<string, unknown>;
type Op = 'select' | 'update' | 'insert' | 'delete' | 'upsert';

interface Fault {
  table: string;
  op: Op;
  message: string;
  /** Narrow the fault to one write: sees the filters and the payload. */
  when?: (ctx: { filters: Array<[string, unknown]>; payload: Row }) => boolean;
}

const store = vi.hoisted(() => ({
  db: {} as Record<string, Row[]>,
  faults: [] as Fault[],
  seq: 0,
}));

const makeClient = vi.hoisted(() => () => {
  function query(table: string) {
    const filters: Array<[string, unknown]> = [];
    const neqFilters: Array<[string, unknown]> = [];
    let op: Op = 'select';
    let payload: Row = {};
    let onConflict: string[] = [];

    const matching = () =>
      (store.db[table] ?? []).filter(
        (r) =>
          filters.every(([c, v]) => r[c] === v) &&
          neqFilters.every(([c, v]) => r[c] !== v),
      );

    const fault = () =>
      store.faults.find(
        (f) => f.table === table && f.op === op && (!f.when || f.when({ filters, payload })),
      );

    const run = (): { data: Row[] | null; error: { message: string } | null } => {
      const f = fault();
      if (f) return { data: null, error: { message: f.message } };
      if (op === 'insert' || op === 'upsert') {
        const existing =
          op === 'upsert'
            ? (store.db[table] ?? []).find((r) => onConflict.every((c) => r[c] === payload[c]))
            : undefined;
        if (existing) {
          Object.assign(existing, payload);
          return { data: [existing], error: null };
        }
        const row = { id: `00000000-0000-4000-8000-${String(++store.seq).padStart(12, '0')}`, ...payload };
        (store.db[table] ??= []).push(row);
        return { data: [row], error: null };
      }
      if (op === 'update') {
        // `.select()` after an update returns the rows that matched — the count
        // the action needs to notice that it changed nothing at all.
        const hit = matching();
        for (const r of hit) Object.assign(r, payload);
        return { data: hit, error: null };
      }
      if (op === 'delete') {
        const doomed = matching();
        store.db[table] = (store.db[table] ?? []).filter((r) => !doomed.includes(r));
        return { data: null, error: null };
      }
      return { data: matching(), error: null };
    };

    const api = {
      select() { return api; },
      insert(p: Row) { op = 'insert'; payload = p; return api; },
      upsert(p: Row, opts?: { onConflict?: string }) {
        op = 'upsert';
        payload = p;
        onConflict = (opts?.onConflict ?? '').split(',').filter(Boolean);
        return api;
      },
      update(p: Row) { op = 'update'; payload = p; return api; },
      delete() { op = 'delete'; return api; },
      eq(c: string, v: unknown) { filters.push([c, v]); return api; },
      neq(c: string, v: unknown) { neqFilters.push([c, v]); return api; },
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
vi.mock('../actions/_shared', () => ({
  requireCapability: async () => ({ id: 'admin-1', role: 'admin' }),
}));

import { createFeeTier, updateFeeTier, markTournamentFeePaid } from '../actions/tournament-fees';

const TOURNAMENT_A = '11111111-1111-4111-8111-111111111111';
const TOURNAMENT_B = '22222222-2222-4222-8222-222222222222';
const PLAYER = '33333333-3333-4333-8333-333333333333';
const MEMBER_TIER = '44444444-4444-4444-8444-444444444444';
const GUEST_TIER = '55555555-5555-4555-8555-555555555555';
const STUDENT_TIER = '77777777-7777-4777-8777-777777777777';
const OTHER_TIER = '66666666-6666-4666-8666-666666666666';

const tiers = () => store.db.tournament_fee_tiers ?? [];
const tier = (id: string) => tiers().find((t) => t.id === id)!;
const defaultsOf = (tournamentId: string) =>
  tiers().filter((t) => t.tournament_id === tournamentId && t.is_default);
const feeRows = () => store.db.tournament_fees ?? [];

// The exact shape from the report: tournament A has a default "Member" tier and
// a non-default "Guest" tier, so "Guest" is the name that collides. Tournament B
// has its own, differently priced tier.
beforeEach(() => {
  store.faults = [];
  store.seq = 0;
  store.db = {
    tournament_fee_tiers: [
      { id: MEMBER_TIER, tournament_id: TOURNAMENT_A, name: 'Member', amount_cents: 1000, is_default: true },
      { id: GUEST_TIER, tournament_id: TOURNAMENT_A, name: 'Guest', amount_cents: 1500, is_default: false },
      { id: STUDENT_TIER, tournament_id: TOURNAMENT_A, name: 'Student', amount_cents: 500, is_default: false },
      { id: OTHER_TIER, tournament_id: TOURNAMENT_B, name: 'Other cup', amount_cents: 9900, is_default: true },
    ],
    tournament_fees: [],
    audit_logs: [],
  };
});

// Postgres refusing UNIQUE(tournament_id, name), modelled on the tier name.
function nameCollision(name: string, op: Op) {
  store.faults.push({
    table: 'tournament_fee_tiers',
    op,
    when: ({ payload }) => payload.name === name,
    message: 'duplicate key value violates unique constraint "tournament_fee_tiers_tournament_id_name_key"',
  });
}

describe('createFeeTier', () => {
  it('moves the default onto the new tier on the happy path', async () => {
    await createFeeTier({ tournament_id: TOURNAMENT_A, name: 'Alumni', amount_cents: 800, is_default: true });

    expect(defaultsOf(TOURNAMENT_A)).toHaveLength(1);
    expect(defaultsOf(TOURNAMENT_A)[0]!.name).toBe('Alumni');
    expect(tier(MEMBER_TIER).is_default).toBe(false);
  });

  // The reported failure. The old order cleared "Member" and only then tried the
  // insert, so a colliding name cost the tournament its default. The assertion
  // that matters is that Member is STILL the default — the broken code threw
  // here too.
  it('keeps the existing default when the insert fails on a duplicate name', async () => {
    nameCollision('Guest', 'insert');

    await expect(
      createFeeTier({ tournament_id: TOURNAMENT_A, name: 'Guest', amount_cents: 500, is_default: true }),
    ).rejects.toThrow(/duplicate key/);

    expect(tier(MEMBER_TIER).is_default).toBe(true);
    expect(defaultsOf(TOURNAMENT_A)).toHaveLength(1);
    // And nothing half-made: the rejected tier does not exist either.
    expect(tiers().filter((t) => t.tournament_id === TOURNAMENT_A)).toHaveLength(3);
  });

  // The window that remains once the insert has succeeded: clearing the old
  // default and setting the new one are two statements with no transaction
  // between them (uq_tournament_fee_tiers_default is a partial unique index, so
  // it cannot be one). If the second fails, the first is undone.
  it('restores the previous default when the promotion fails halfway', async () => {
    store.faults.push({
      table: 'tournament_fee_tiers',
      op: 'update',
      // Only the promotion of the NEW tier fails; the restore of Member does not.
      when: ({ filters, payload }) =>
        payload.is_default === true && !filters.some(([, v]) => v === MEMBER_TIER),
      message: 'connection reset',
    });

    await expect(
      createFeeTier({ tournament_id: TOURNAMENT_A, name: 'Alumni', amount_cents: 800, is_default: true }),
    ).rejects.toThrow();

    expect(defaultsOf(TOURNAMENT_A)).toHaveLength(1);
    expect(tier(MEMBER_TIER).is_default).toBe(true);
  });

  // Matching zero rows is not an error in PostgREST, so a tier deleted between
  // the clear and the promotion produced a silent success with the tournament
  // left holding no default at all — the outcome the whole reorder exists to
  // prevent, arrived at by a different road.
  it('restores the previous default when the tier to promote has vanished', async () => {
    await expect(
      (async () => {
        // Simulate the concurrent delete: the tier is gone by the time the
        // promotion update runs, so that update matches nothing.
        store.faults.push({
          table: 'tournament_fee_tiers',
          op: 'update',
          when: ({ filters, payload }) => {
            if (payload.is_default !== true) return false;
            const target = filters.find(([c]) => c === 'id')?.[1];
            if (target !== MEMBER_TIER) {
              store.db.tournament_fee_tiers = tiers().filter((t) => t.id !== target);
            }
            return false;
          },
          message: 'never fires — this fault only observes',
        });
        await createFeeTier({ tournament_id: TOURNAMENT_A, name: 'Alumni', amount_cents: 800, is_default: true });
      })(),
    ).rejects.toThrow(/no longer exists/i);

    expect(defaultsOf(TOURNAMENT_A)).toHaveLength(1);
    expect(tier(MEMBER_TIER).is_default).toBe(true);
  });

  // Last resort. If the restore fails too the tournament really does have no
  // default, and the only useful thing left is to say so out loud rather than
  // let it be discovered as a $0 entry fee weeks later.
  it('says so plainly when even the restore fails', async () => {
    store.faults.push({
      table: 'tournament_fee_tiers',
      op: 'update',
      when: ({ payload }) => payload.is_default === true,
      message: 'connection reset',
    });

    await expect(
      createFeeTier({ tournament_id: TOURNAMENT_A, name: 'Alumni', amount_cents: 800, is_default: true }),
    ).rejects.toThrow(/no default tier/i);
  });

  // The tier survives a failed promotion by design — it is the visible,
  // retryable half-state. But the admin has to be told, or they retry the same
  // name against a stale list and get a bare duplicate-key error for a tier
  // they are certain was never created.
  it('says the tier was created when only the promotion failed', async () => {
    store.faults.push({
      table: 'tournament_fee_tiers',
      op: 'update',
      when: ({ filters, payload }) =>
        payload.is_default === true && !filters.some(([, v]) => v === MEMBER_TIER),
      message: 'connection reset',
    });

    await expect(
      createFeeTier({ tournament_id: TOURNAMENT_A, name: 'Alumni', amount_cents: 800, is_default: true }),
    ).rejects.toThrow(/"Alumni" was created/);

    expect(tiers().some((t) => t.name === 'Alumni')).toBe(true);
  });
});

describe('updateFeeTier', () => {
  it('keeps the existing default when the rename fails on a duplicate name', async () => {
    nameCollision('Guest', 'update');

    await expect(
      updateFeeTier(STUDENT_TIER, { name: 'Guest', is_default: true }),
    ).rejects.toThrow(/duplicate key/);

    expect(tier(MEMBER_TIER).is_default).toBe(true);
    expect(defaultsOf(TOURNAMENT_A)).toHaveLength(1);
    expect(tier(STUDENT_TIER).name).toBe('Student');
  });

  it('promotes an existing tier to default', async () => {
    await updateFeeTier(GUEST_TIER, { is_default: true });

    expect(tier(GUEST_TIER).is_default).toBe(true);
    expect(tier(MEMBER_TIER).is_default).toBe(false);
    expect(defaultsOf(TOURNAMENT_A)).toHaveLength(1);
  });

  // `{ is_default: true }` alone leaves nothing to write in the field update, so
  // the split must not send PostgREST an empty payload.
  it('renames without touching the default flag', async () => {
    await updateFeeTier(GUEST_TIER, { name: 'Visitor' });

    expect(tier(GUEST_TIER).name).toBe('Visitor');
    expect(tier(MEMBER_TIER).is_default).toBe(true);
  });

  // feeTierSchema.partial() accepts tournament_id, and this action used to pass
  // the whole payload straight through — so a tier could be moved to another
  // tournament, turning every tournament_fees row already pointing at it into
  // the cross-tournament reference markTournamentFeePaid now refuses to create.
  it('will not move a tier to a different tournament', async () => {
    await updateFeeTier(GUEST_TIER, { tournament_id: TOURNAMENT_B, name: 'Visitor' });

    expect(tier(GUEST_TIER).tournament_id).toBe(TOURNAMENT_A);
    expect(tier(GUEST_TIER).name).toBe('Visitor');
  });
});

describe('markTournamentFeePaid', () => {
  it('snapshots the chosen tier of the right tournament', async () => {
    await markTournamentFeePaid({ tournament_id: TOURNAMENT_A, player_id: PLAYER, tier_id: GUEST_TIER });

    expect(feeRows()).toHaveLength(1);
    expect(feeRows()[0]!.amount_cents).toBe(1500);
    expect(feeRows()[0]!.tier_id).toBe(GUEST_TIER);
  });

  it('falls back to the tournament default when no tier is named', async () => {
    await markTournamentFeePaid({ tournament_id: TOURNAMENT_A, player_id: PLAYER });

    expect(feeRows()[0]!.tier_id).toBe(MEMBER_TIER);
    expect(feeRows()[0]!.amount_cents).toBe(1000);
  });

  // The reported trigger: tournament B's tier, priced at $99, silently copied
  // onto a tournament A fee. Asserting no row is written is what discriminates —
  // the broken code wrote one and reported success.
  it("refuses a tier belonging to another tournament", async () => {
    await expect(
      markTournamentFeePaid({ tournament_id: TOURNAMENT_A, player_id: PLAYER, tier_id: OTHER_TIER }),
    ).rejects.toThrow(/does not belong to this tournament/i);

    expect(feeRows()).toHaveLength(0);
  });

  // Stronger than the reported repro, and deliberately so: the old code only
  // read the tier when it needed an amount from it, so supplying an explicit
  // amount skipped the lookup entirely and stored the foreign tier_id with no
  // check at all. A tier is now validated whenever one is named.
  it('refuses a foreign tier even when the amount is supplied explicitly', async () => {
    await expect(
      markTournamentFeePaid({
        tournament_id: TOURNAMENT_A, player_id: PLAYER, tier_id: OTHER_TIER, amount_cents: 1000,
      }),
    ).rejects.toThrow(/does not belong to this tournament/i);

    expect(feeRows()).toHaveLength(0);
  });

  it('refuses a tier id that does not exist', async () => {
    await expect(
      markTournamentFeePaid({
        tournament_id: TOURNAMENT_A, player_id: PLAYER, tier_id: '88888888-8888-4888-8888-888888888888',
      }),
    ).rejects.toThrow(/does not belong to this tournament/i);

    expect(feeRows()).toHaveLength(0);
  });
});
