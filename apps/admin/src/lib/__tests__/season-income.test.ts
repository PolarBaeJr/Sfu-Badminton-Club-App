import { describe, it, expect } from 'vitest';
import { getSeasonIncome } from '../season-income';

// THE TABLES THAT NO LONGER EXIST.
//
// 00094 folded tournament_fees and reinstatement_fees into club_fees, and
// 00159 folded other_income and club_expenses into club_ledger. The dangerous
// half of both changes is not the writing, it is the reading: a version of
// season-income.ts that sums club_fees AND keeps either old branch counts every
// entry fee and every reinstatement TWICE, and the result is a plausible-looking
// number that overstates the club's income.
//
// A numeric assertion would not catch it — it would just start failing with a
// number somebody could "fix" by editing the expectation. So the mock refuses
// to serve these tables at all. Any residual read is an exception with the
// table's name in it, which is a failure nobody can misread.
const RETIRED = [
  'tournament_fees',
  'reinstatement_fees',
  'other_income',
  'club_expenses',
] as const;

// Minimal PostgREST-shaped stub: every builder method returns `this`, and the
// chain is awaited for its rows. Records which table each chain started from,
// and which filters it applied, so a test can assert the ones that matter.
//
// club_fees rows are keyed BY fee_type, because that is now the only thing
// separating three ledgers that share a table. A chain that never filters on
// fee_type gets every row in the table, which is exactly the double count the
// filter exists to prevent — so forgetting it fails loudly here too.
//
// club_ledger is keyed BY direction for the identical reason (00159). An income
// read that forgets `.eq('direction', 'income')` gets the expenses too, and the
// club's income figure silently grows by everything it spent. The fake models
// that rather than hiding it: no filter means the whole table comes back.
type Row = { amount_cents: number | null };

function makeClient(rows: {
  dues?: Row[];
  tournament?: Row[];
  reinstatement?: Row[];
  income?: Row[];
  expense?: Row[];
}) {
  const calls: { table: string; filters: string[] }[] = [];
  return {
    calls,
    from(table: string) {
      if ((RETIRED as readonly string[]).includes(table)) {
        throw new Error(
          `season-income read ${table}, which 00094 retired — its rows are club_fees rows now, ` +
            'so reading both is how every payment gets counted twice.',
        );
      }
      const entry = { table, filters: [] as string[] };
      calls.push(entry);
      let feeType: string | null = null;
      let direction: string | null = null;
      const chain: Record<string, unknown> = {
        select: () => chain,
        eq: (col: string, val: unknown) => {
          if (col === 'fee_type') feeType = String(val);
          if (col === 'direction') direction = String(val);
          entry.filters.push(`eq:${col}=${val}`);
          return chain;
        },
        gte: (col: string, val: unknown) => { entry.filters.push(`gte:${col}=${val}`); return chain; },
        lte: (col: string, val: unknown) => { entry.filters.push(`lte:${col}=${val}`); return chain; },
        not: (col: string, op: string) => { entry.filters.push(`not:${col}:${op}`); return chain; },
        then: (resolve: (v: { data: unknown }) => unknown) => {
          if (table === 'club_ledger') {
            const both = [...(rows.income ?? []), ...(rows.expense ?? [])];
            // Unfiltered means the WHOLE ledger, both directions — exactly what
            // PostgREST would hand back, and exactly the over-count that makes
            // the missing filter a money bug rather than a style note.
            if (direction == null) return resolve({ data: both });
            return resolve({ data: rows[direction as 'income' | 'expense'] ?? [] });
          }
          if (table !== 'club_fees') return resolve({ data: [] });
          // No fee_type filter: hand back the WHOLE table, which is what an
          // unfiltered query would really return.
          const all = [...(rows.dues ?? []), ...(rows.tournament ?? []), ...(rows.reinstatement ?? [])];
          if (feeType == null) return resolve({ data: all });
          return resolve({ data: rows[feeType as 'dues' | 'tournament' | 'reinstatement'] ?? [] });
        },
      };
      return chain;
    },
  };
}

const SEASON = { id: 'season-1' };

describe('getSeasonIncome', () => {
  // The bug this file exists for: the figure summed dues only, so a recorded
  // reinstatement or tournament payment left "income collected" reading $0.00
  // while the money sat in the database.
  it('adds every kind of fee, not just dues', async () => {
    const client = makeClient({
      dues: [{ amount_cents: 5000 }, { amount_cents: 1500 }],
      tournament: [{ amount_cents: 2500 }],
      reinstatement: [{ amount_cents: 2000 }],
      income: [{ amount_cents: 3000 }],
    });
    const income = await getSeasonIncome(client as never, SEASON);

    expect(income.clubCents).toBe(6500);
    expect(income.tournamentCents).toBe(2500);
    expect(income.reinstatementCents).toBe(2000);
    expect(income.otherCents).toBe(3000);
    expect(income.totalCents).toBe(14000);
  });

  // THE DOUBLE-COUNT PROOF, stated as arithmetic rather than as a magic number.
  //
  // Every fee in the ledger is paid, so the club's fee income is the sum of the
  // rows, once each — no matter how they are split across the three kinds. If
  // any slice overlapped another (a missing fee_type filter, a resurrected
  // tournament_fees branch) the total would exceed this and the test would say
  // so for every possible seeding, not just this one.
  it('counts each payment exactly once, whatever kind it is', async () => {
    const dues = [{ amount_cents: 4000 }, { amount_cents: 4000 }];
    const tournament = [{ amount_cents: 1500 }, { amount_cents: 1500 }, { amount_cents: 1500 }];
    const reinstatement = [{ amount_cents: 2000 }];
    const everyFee = [...dues, ...tournament, ...reinstatement];
    const onceEach = everyFee.reduce((n, r) => n + (r.amount_cents ?? 0), 0);

    const income = await getSeasonIncome(
      makeClient({ dues, tournament, reinstatement }) as never,
      SEASON,
    );

    expect(income.totalCents).toBe(onceEach);
    // And the three parts partition the whole — no row in two of them.
    expect(income.clubCents + income.tournamentCents + income.reinstatementCents).toBe(onceEach);
  });

  // The other half of the same guarantee: the three reads must be three
  // DIFFERENT slices. Without a fee_type filter each one returns the whole
  // table, so the total comes out at three times the money.
  it('asks for each kind by name, so the three reads cannot overlap', async () => {
    const client = makeClient({});
    await getSeasonIncome(client as never, SEASON);

    const feeReads = client.calls.filter((c) => c.table === 'club_fees');
    expect(feeReads).toHaveLength(3);
    expect(feeReads.map((c) => c.filters.find((f) => f.startsWith('eq:fee_type='))).sort()).toEqual([
      'eq:fee_type=dues',
      'eq:fee_type=reinstatement',
      'eq:fee_type=tournament',
    ]);
  });

  // Other income (00073) was folded into THIS helper rather than being summed
  // by a sibling, so that /fees and /dashboard both pick it up from the one
  // call they already make. A donation that showed on one page and not the
  // other would be the original bug wearing a new hat.
  it('counts other income toward the same total the pages already read', async () => {
    const client = makeClient({ income: [{ amount_cents: 4200 }] });
    const income = await getSeasonIncome(client as never, SEASON);
    expect(income.totalCents).toBe(4200);
  });

  // 00159's specific hazard, and the reason the fake serves the WHOLE ledger to
  // an unfiltered read. Income and expenses now share a table, so a read that
  // forgets `.eq('direction', 'income')` adds what the club SPENT to what it
  // TOOK IN. The number that comes out is not obviously wrong — it is larger,
  // which is the flattering direction, on the one figure the owner asked for by
  // name. Only the income row may be counted here.
  it('does not count spending as income', async () => {
    const client = makeClient({
      income: [{ amount_cents: 4200 }],
      expense: [{ amount_cents: 9900 }],
    });
    const income = await getSeasonIncome(client as never, SEASON);
    expect(income.otherCents).toBe(4200);
    expect(income.totalCents).toBe(4200);
  });

  // The filter itself, asserted directly rather than only through the total —
  // so that a future fake which happened to return the right rows for the wrong
  // reason cannot make this pass.
  it('asks the ledger for the income direction explicitly', async () => {
    const client = makeClient({});
    await getSeasonIncome(client as never, SEASON);
    const ledger = client.calls.find((c) => c.table === 'club_ledger');
    expect(ledger).toBeDefined();
    expect(ledger?.filters).toContain('eq:direction=income');
  });

  it('reports a reinstatement-only season rather than zero', async () => {
    const client = makeClient({ reinstatement: [{ amount_cents: 2000 }] });
    const income = await getSeasonIncome(client as never, SEASON);
    expect(income.totalCents).toBe(2000);
  });

  it('treats a missing amount as zero rather than NaN', async () => {
    const client = makeClient({ dues: [{ amount_cents: null }, { amount_cents: 1000 }] });
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
  // the deploy of a migration: code ships through CI, migrations are applied by
  // hand, and in between every query against the new shape fails.
  it('throws rather than counting a failed ledger as empty', async () => {
    const client = {
      from: () => {
        const chain: Record<string, unknown> = {
          select: () => chain,
          eq: () => chain,
          not: () => chain,
          then: (resolve: (v: unknown) => unknown) =>
            resolve({ data: null, error: { message: 'relation "club_ledger" does not exist' } }),
        };
        return chain;
      },
    };

    await expect(getSeasonIncome(client as never, SEASON)).rejects.toThrow(/club_ledger/);
  });

  // Season is a COLUMN on every ledger now, never a join and never a date
  // window. Entry fees used to reach a season through tournaments.season_id.
  it('scopes every ledger to the season by its own season_id', async () => {
    const client = makeClient({});
    await getSeasonIncome(client as never, SEASON);

    for (const call of client.calls) {
      expect(call.filters).toContain('eq:season_id=season-1');
      // Unpaid rows are a liability, not income — EVERY read must exclude them.
      // One rule for all of them: a ledger with its own idea of what counts is
      // one more thing to get wrong every time this function changes.
      expect(call.filters).toContain('not:paid_at:is');
    }
    expect(client.calls.map((c) => c.table)).toContain('club_ledger');
  });

  // Regression guard for the gap that motivated 00069: a reinstatement paid
  // between terms used to fall outside every date window and vanish from every
  // total. Scoping by season_id means the date it was paid cannot exclude it.
  it('does not filter any ledger by date', async () => {
    const client = makeClient({ reinstatement: [{ amount_cents: 700 }] });
    const income = await getSeasonIncome(client as never, SEASON);
    expect(income.totalCents).toBe(700);

    for (const call of client.calls) {
      expect(call.filters.some((f) => f.includes('paid_at='))).toBe(false);
    }
  });
});
