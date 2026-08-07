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

const SEASON = { id: 'season-1', start_date: '2026-09-01', end_date: '2026-12-31' };

describe('getSeasonIncome', () => {
  // The bug this file exists for: the figure summed club_fees only, so a
  // recorded reinstatement or tournament payment left "income collected"
  // reading $0.00 while the money sat in the database.
  it('adds all three ledgers, not just club fees', async () => {
    const client = makeClient({
      club_fees: [{ amount_cents: 5000 }, { amount_cents: 1500 }],
      tournament_fees: [{ amount_cents: 2500 }],
      reinstatement_fees: [{ amount_cents: 2000 }],
    });
    const income = await getSeasonIncome(client as never, SEASON);

    expect(income.clubCents).toBe(6500);
    expect(income.tournamentCents).toBe(2500);
    expect(income.reinstatementCents).toBe(2000);
    expect(income.totalCents).toBe(11000);
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
    // reinstatement_fees has no season column at all — a ban is not a
    // season-scoped event — so it is bucketed by when it was paid.
    expect(byTable['reinstatement_fees']).toContain('gte:paid_at=2026-09-01');
    expect(byTable['reinstatement_fees']).toContain('lte:paid_at=2026-12-31');

    // Unpaid rows are a liability, not income — every ledger must exclude them.
    for (const t of ['club_fees', 'tournament_fees', 'reinstatement_fees']) {
      expect(byTable[t]).toContain('not:paid_at:is');
    }
  });

  // An open-ended season runs to "now". Without the fallback the reinstatement
  // window would be empty and that ledger would silently drop out again.
  it('runs an open-ended season up to now', async () => {
    const client = makeClient({ reinstatement_fees: [{ amount_cents: 700 }] });
    const income = await getSeasonIncome(client as never, { ...SEASON, end_date: null });
    expect(income.totalCents).toBe(700);

    const reinstatement = client.calls.find((c) => c.table === 'reinstatement_fees')!;
    expect(reinstatement.filters.some((f) => f.startsWith('lte:paid_at='))).toBe(true);
  });
});
