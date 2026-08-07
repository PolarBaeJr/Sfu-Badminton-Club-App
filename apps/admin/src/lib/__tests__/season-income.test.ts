import { describe, it, expect } from 'vitest';
import { getSeasonIncome } from '../season-income';

// Minimal PostgREST-shaped stub: every builder method returns `this`, and the
// chain is awaited for its rows. Records which table each chain started from so
// a test can assert the filters that actually matter.
function makeClient(rows: Record<string, { amount_cents: number | null }[]>) {
  const calls: { table: string; filters: string[] }[] = [];
  return {
    calls,
    from(table: string) {
      const entry = { table, filters: [] as string[] };
      calls.push(entry);
      const chain: Record<string, unknown> = {
        select: () => chain,
        eq: (col: string, val: unknown) => { entry.filters.push(`eq:${col}=${val}`); return chain; },
        gte: (col: string, val: unknown) => { entry.filters.push(`gte:${col}=${val}`); return chain; },
        lte: (col: string, val: unknown) => { entry.filters.push(`lte:${col}=${val}`); return chain; },
        not: (col: string, op: string) => { entry.filters.push(`not:${col}:${op}`); return chain; },
        then: (resolve: (v: { data: unknown }) => unknown) =>
          resolve({ data: rows[table] ?? [] }),
      };
      return chain;
    },
  };
}

const SEASON = { id: 'season-1' };

describe('getSeasonIncome', () => {
  // The bug this file exists for: the figure summed club_fees only, so a
  // recorded reinstatement or tournament payment left "income collected"
  // reading $0.00 while the money sat in the database.
  it('adds every ledger, not just club fees', async () => {
    const client = makeClient({
      club_fees: [{ amount_cents: 5000 }, { amount_cents: 1500 }],
      tournament_fees: [{ amount_cents: 2500 }],
      reinstatement_fees: [{ amount_cents: 2000 }],
      other_income: [{ amount_cents: 3000 }],
    });
    const income = await getSeasonIncome(client as never, SEASON);

    expect(income.clubCents).toBe(6500);
    expect(income.tournamentCents).toBe(2500);
    expect(income.reinstatementCents).toBe(2000);
    expect(income.otherCents).toBe(3000);
    expect(income.totalCents).toBe(14000);
  });

  // other_income (00073) was folded into THIS helper rather than being summed
  // by a sibling, so that /fees and /dashboard both pick it up from the one
  // call they already make. A donation that showed on one page and not the
  // other would be the original bug wearing a new hat.
  it('counts other income toward the same total the pages already read', async () => {
    const client = makeClient({ other_income: [{ amount_cents: 4200 }] });
    const income = await getSeasonIncome(client as never, SEASON);
    expect(income.totalCents).toBe(4200);
  });

  it('reports a reinstatement-only season rather than zero', async () => {
    const client = makeClient({ reinstatement_fees: [{ amount_cents: 2000 }] });
    const income = await getSeasonIncome(client as never, SEASON);
    expect(income.totalCents).toBe(2000);
  });

  it('treats a missing amount as zero rather than NaN', async () => {
    const client = makeClient({
      club_fees: [{ amount_cents: null }, { amount_cents: 1000 }],
    });
    const income = await getSeasonIncome(client as never, SEASON);
    expect(income.totalCents).toBe(1000);
  });

  it('is zero when nothing has been paid', async () => {
    const income = await getSeasonIncome(makeClient({}) as never, SEASON);
    expect(income.totalCents).toBe(0);
  });

  // A ledger that FAILED to load is not a ledger with nothing in it. Summing
  // `data ?? []` past an error produces a total that looks ordinary and is
  // short by the whole failed ledger — the same shape of wrongness as the
  // original bug, arrived at a different way. The window this actually opens is
  // the deploy of 00073: code ships through CI, migrations are applied by hand,
  // and in between every other_income query fails.
  it('throws rather than counting a failed ledger as empty', async () => {
    const client = {
      from: () => {
        const chain: Record<string, unknown> = {
          select: () => chain,
          eq: () => chain,
          not: () => chain,
          then: (resolve: (v: unknown) => unknown) =>
            resolve({ data: null, error: { message: 'relation "other_income" does not exist' } }),
        };
        return chain;
      },
    };

    await expect(getSeasonIncome(client as never, SEASON)).rejects.toThrow(/other_income/);
  });

  // Each ledger reaches a season by a different route, and getting any of them
  // wrong silently changes a money figure.
  it('scopes each ledger to the season the right way', async () => {
    const client = makeClient({});
    await getSeasonIncome(client as never, SEASON);

    const byTable = Object.fromEntries(client.calls.map((c) => [c.table, c.filters]));

    // club_fees owns season_id directly.
    expect(byTable['club_fees']).toContain('eq:season_id=season-1');
    // tournament_fees reaches it through its tournament (an inner join in the
    // select), so the filter is on the joined column.
    expect(byTable['tournament_fees']).toContain('eq:tournaments.season_id=season-1');
    // reinstatement_fees carries season_id directly since 00069. It used to be
    // bucketed by paid_at, and money paid outside every season window then
    // belonged to no season and showed in no total.
    expect(byTable['reinstatement_fees']).toContain('eq:season_id=season-1');
    // other_income carries season_id NOT NULL since 00073 — the same lesson,
    // applied at creation instead of retrofitted.
    expect(byTable['other_income']).toContain('eq:season_id=season-1');

    // Unpaid rows are a liability, not income — EVERY ledger must exclude them.
    // One rule for all four: a ledger with its own idea of what counts is a
    // fifth thing to get wrong every time this function changes.
    for (const t of ['club_fees', 'tournament_fees', 'reinstatement_fees', 'other_income']) {
      expect(byTable[t]).toContain('not:paid_at:is');
    }
  });

  // Regression guard for the gap that motivated 00069: a reinstatement paid
  // between terms used to fall outside every date window and vanish from every
  // total. Scoping by season_id means the date it was paid cannot exclude it.
  it('does not filter reinstatements by date at all', async () => {
    const client = makeClient({ reinstatement_fees: [{ amount_cents: 700 }] });
    const income = await getSeasonIncome(client as never, SEASON);
    expect(income.totalCents).toBe(700);

    const reinstatement = client.calls.find((c) => c.table === 'reinstatement_fees')!;
    expect(reinstatement.filters.some((f) => f.includes('paid_at=')))
      .toBe(false);
  });
});
