// PINNING THE TWO NUMBERS AT THE TOP OF ADMIN /challenges.
//
// *** WHY THIS FILE EXISTS. ***
//
// Both tiles used to be measured off the page's own table, which is capped at
// the newest 50 rows. "Total Challenges" printed that array's length, so a club
// with 400 challenges read 50 forever, and "Active" filtered the same 50, so a
// genuinely open challenge outside the newest 50 was missing from the tile as
// well as from the table. The cap is fine. Measuring the club with it was not.
//
// The bug is invisible below 51 challenges, which is where this club is today,
// so every test here works above the cap on purpose: a fixture of 50 rows would
// pass against the old code and prove nothing.
//
// NO NETWORK AND NO CREDENTIALS. The client is a hand-built fake that records
// calls. Nothing is constructed against a real URL and nothing leaves the
// process.

import { describe, it, expect } from 'vitest';
import { loadChallengeCounts, ACTIVE_STATUSES } from '../challenge-counts';

/** The real function's client parameter, so the fake is cast to exactly that. */
type Db = Parameters<typeof loadChallengeCounts>[0];

type Call = { head?: boolean; in?: [string, readonly string[]] };

/**
 * A stand-in for the service-role client, recording what was asked of it.
 *
 * Both reads are head counts, so the builder is chainable and awaitable: every
 * method returns `this` and `then` resolves the configured result. That is the
 * shape supabase-js presents, which is what makes driving the real
 * loadChallengeCounts worth more than reproducing its queries.
 */
function fakeDb(opts: { counts?: number[]; error?: unknown; nullCount?: boolean }) {
  const calls: Call[] = [];
  const tables: string[] = [];
  let nth = 0;

  const builder = () => {
    const call: Call = {};
    calls.push(call);
    const self = {
      select: (_cols: string, options?: { head?: boolean }) => {
        call.head = options?.head;
        return self;
      },
      in: (column: string, values: readonly string[]) => {
        call.in = [column, [...values]];
        return self;
      },
      then: (resolve: (value: { count: number | null; error: unknown }) => unknown) =>
        Promise.resolve(
          opts.error
            ? { count: null, error: opts.error }
            : opts.nullCount
              // How a head count really fails: no body, so no error either.
              ? { count: null, error: null }
              : { count: opts.counts?.[nth++] ?? 0, error: null },
        ).then(resolve),
    };
    return self;
  };

  const db = {
    from: (table: string) => {
      tables.push(table);
      return builder();
    },
  };

  // Cast through the function's own parameter type rather than `any`: the fake
  // implements the handful of methods loadChallengeCounts uses, not the client.
  return { db: db as unknown as Db, calls, tables };
}

describe('the admin challenges tiles', () => {
  it('counts every challenge, not the newest 50 the table holds', async () => {
    // Deliberately above the cap. This is the number the old code could never
    // have produced, whatever the club's real total was.
    const { db, calls, tables } = fakeDb({ counts: [412, 37] });

    const result = await loadChallengeCounts(db);

    expect(result).toEqual({ state: 'ok', total: 412, active: 37 });
    expect(tables).toEqual(['challenges', 'challenges']);
    // Head counts: no rows are transferred to produce either figure.
    expect(calls.every((c) => c.head === true)).toBe(true);
  });

  it('counts the live ones in the database, not in the loaded page', async () => {
    const { db, calls } = fakeDb({ counts: [412, 37] });

    await loadChallengeCounts(db);

    const active = calls.find((c) => c.in);
    // The same three statuses the dashboard's own head count uses, and the same
    // three the row actions branch on. A challenge is live when somebody still
    // owes it an answer.
    expect(active?.in).toEqual(['status', ['proposed', 'partially_confirmed', 'accepted']]);
    // And the total is genuinely unfiltered: filtering it would make "Total"
    // mean something narrower than the word.
    expect(calls.filter((c) => c.in)).toHaveLength(1);
  });

  it('keeps the status list in one place', () => {
    // The page's row actions import this same constant. Two copies of it is
    // how the tile and the table come to disagree about what "active" means.
    expect([...ACTIVE_STATUSES]).toEqual(['proposed', 'partially_confirmed', 'accepted']);
  });

  it('says the counts are unavailable rather than claiming zero', async () => {
    // supabase-js RESOLVES a PostgREST 400/403 instead of throwing, so
    // `count ?? 0` would render a confident "0 challenges" over a broken read.
    // A quiet club and a broken console look identical once both are a 0.
    const { db } = fakeDb({ error: { message: 'permission denied' } });

    expect(await loadChallengeCounts(db)).toEqual({ state: 'unavailable' });
  });

  it('says unavailable for the way a head count ACTUALLY fails', async () => {
    // THIS IS THE ONE THAT MATTERS, and the test above does not cover it.
    //
    // A HEAD request has no body, so PostgREST's error document never arrives
    // and supabase-js resolves the failure as { count: null, error: null,
    // status: 204 }. Measured against this stack: a head count on a missing
    // table returns exactly that, while the same read as a GET returns
    // PGRST205. So `error` is silent on the failure this function is most
    // likely to meet, and a guard that only checks `error` renders 0.
    //
    // I shipped that guard and caught it in the browser, not here.
    const { db } = fakeDb({ nullCount: true });

    expect(await loadChallengeCounts(db)).toEqual({ state: 'unavailable' });
  });

  it('reports a genuinely empty club as zero, which is an answer', async () => {
    const { db } = fakeDb({ counts: [0, 0] });

    expect(await loadChallengeCounts(db)).toEqual({ state: 'ok', total: 0, active: 0 });
  });
});
