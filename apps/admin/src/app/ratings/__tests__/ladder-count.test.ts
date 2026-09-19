// PINNING WHERE THE ADMIN LADDER CARD GETS ITS POPULATION FROM.
//
// *** WHY THIS FILE EXISTS. ***
//
// The card used to count `ratings` outright and print the answer as "N members
// on the ladder". A rating row outlives eligibility on purpose, so on
// production 2026-09-19 it said 39 while the ladder had 31: 5 inactive, 2 opted
// out with hide_from_leaderboard, 2 pending approval, one person in two of
// those at once.
//
// The tempting fix is to copy the leaderboard's WHERE clause into the admin
// page. That is the thing these tests exist to prevent. get_leaderboard() is
// where the club's visibility rule lives, api/discord/leaderboard already
// spells out why nobody re-filters it, and a second copy is a copy that
// drifts. Note how cheaply the drift would have passed review: the rule has
// FOUR clauses and the club currently has zero suspended members, so a
// three-clause copy would have measured as correct against production and gone
// wrong the first time somebody was suspended.
//
// So these tests assert a negative as much as a positive. The counts must come
// from the function, and the page must never mention active_flag,
// hide_from_leaderboard or status at all.
//
// NO NETWORK AND NO CREDENTIALS. The client is a hand-built fake that records
// calls. Nothing is constructed against a real URL and nothing leaves the
// process.

import { describe, it, expect } from 'vitest';
import { loadLadder } from '../ladder-count';

/** The real function's client parameter, so the fake is cast to exactly that. */
type Db = Parameters<typeof loadLadder>[0];

const THRESHOLD = 10;

type RatingsCall = { in?: [string, readonly string[]]; or?: string };

/**
 * A stand-in for the service-role client, recording what was asked of it.
 *
 * `ratings` answers a head count, so the builder has to be both chainable and
 * awaitable: every method returns `this`, and `then` resolves the configured
 * result. That is the same shape supabase-js presents, which is what makes
 * driving the real loadLadder worth more than reproducing its queries.
 */
function fakeDb(opts: {
  rpcRows?: Array<{ id: string }>;
  rpcError?: unknown;
  counts?: number[];
  countError?: unknown;
}) {
  const rpcCalls: string[] = [];
  const ratingsCalls: RatingsCall[] = [];
  const tables: string[] = [];
  let nth = 0;

  const builder = () => {
    const call: RatingsCall = {};
    ratingsCalls.push(call);
    const self = {
      select: () => self,
      in: (column: string, values: readonly string[]) => {
        call.in = [column, [...values]];
        return self;
      },
      or: (condition: string) => {
        call.or = condition;
        return self;
      },
      then: (resolve: (value: { count: number | null; error: unknown }) => unknown) =>
        Promise.resolve(
          opts.countError
            ? { count: null, error: opts.countError }
            : { count: opts.counts?.[nth++] ?? 0, error: null },
        ).then(resolve),
    };
    return self;
  };

  const db = {
    rpc: (name: string) => {
      rpcCalls.push(name);
      return Promise.resolve(
        opts.rpcError
          ? { data: null, error: opts.rpcError }
          : { data: opts.rpcRows ?? [], error: null },
      );
    },
    from: (table: string) => {
      tables.push(table);
      return builder();
    },
  };

  // Cast through the function's own parameter type rather than `any`: the fake
  // implements the handful of methods loadLadder uses, not the whole client.
  return { db: db as unknown as Db, rpcCalls, ratingsCalls, tables };
}

const roster = (n: number) =>
  Array.from({ length: n }, (_, i) => ({ id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}` }));

describe('the admin ladder card population', () => {
  it('takes the ladder size from get_leaderboard, not from a count of ratings', async () => {
    // 31 eligible members. If the ratings table also held 8 rows for people who
    // are inactive, opted out or pending, this must still say 31.
    const { db, rpcCalls, tables } = fakeDb({ rpcRows: roster(31), counts: [4, 6] });

    const result = await loadLadder(db, true, THRESHOLD);

    expect(rpcCalls).toEqual(['get_leaderboard']);
    expect(result).toMatchObject({ state: 'ok', total: 31 });

    // The ONLY table touched is ratings, and only for the provisional counts.
    // A read of `players` here would mean the visibility rule had been copied.
    expect(new Set(tables)).toEqual(new Set(['ratings']));
  });

  it('never restates the visibility rule the database already owns', async () => {
    const { db, ratingsCalls } = fakeDb({ rpcRows: roster(3), counts: [1, 2] });

    await loadLadder(db, true, THRESHOLD);

    // Four clauses live in get_leaderboard(). None of them may appear here, and
    // the fourth is the one a hand-written copy forgets.
    const everything = JSON.stringify(ratingsCalls);
    for (const clause of [
      'active_flag',
      'hide_from_leaderboard',
      'status',
      'pending_approval',
      'suspended',
    ]) {
      expect(everything).not.toContain(clause);
    }
  });

  it('counts provisional members within the eligible set, on one population', async () => {
    const rows = roster(5);
    const { db, ratingsCalls } = fakeDb({ rpcRows: rows, counts: [2, 3] });

    const result = await loadLadder(db, true, THRESHOLD);

    expect(ratingsCalls).toHaveLength(2);
    for (const call of ratingsCalls) {
      // Scoped to the ids the function returned. Without this the provisional
      // counts would be taken over a wider population than `total`, and
      // KFactorPanel draws the established bar as `total - singlesProvisional`,
      // so the two would not merely be wrong, they would disagree.
      expect(call.in).toEqual(['player_id', rows.map((r) => r.id)]);
    }
    expect(result).toMatchObject({ singlesProvisional: 2, doublesProvisional: 3 });
  });

  it('keeps the flag-OR-threshold rule the engine actually branches on', async () => {
    const { db, ratingsCalls } = fakeDb({ rpcRows: roster(2), counts: [0, 0] });

    await loadLadder(db, true, THRESHOLD);

    // apply_match_result (00041) and getKFactor() both branch on
    // `provisional OR matches_played < threshold`. Counting the stored flag
    // alone would print a figure that does not move when the threshold field
    // on this very page is edited, which is the one thing the card is for.
    expect(ratingsCalls[0]?.or).toBe(
      `singles_provisional.eq.true,singles_matches_played.lt.${THRESHOLD}`,
    );
    expect(ratingsCalls[1]?.or).toBe(
      `doubles_provisional.eq.true,doubles_matches_played.lt.${THRESHOLD}`,
    );
  });

  it('says the count is unavailable rather than claiming zero, when the rpc fails', async () => {
    // supabase-js RESOLVES a PostgREST 400/403 instead of throwing. Rendering
    // `count ?? 0` would paint a confident "0 members on the ladder" over a
    // broken grant, which is a worse lie than the 39 this replaced.
    const { db, tables } = fakeDb({ rpcError: { message: 'permission denied' } });

    expect(await loadLadder(db, true, THRESHOLD)).toEqual({ state: 'unavailable' });
    // And it must not go on to count ratings off a null roster.
    expect(tables).toEqual([]);
  });

  it('says the count is unavailable when a provisional count fails', async () => {
    const { db } = fakeDb({ rpcRows: roster(4), countError: { message: 'permission denied' } });
    expect(await loadLadder(db, true, THRESHOLD)).toEqual({ state: 'unavailable' });
  });

  it('reports an empty ladder as zero without asking for an empty IN list', async () => {
    const { db, tables } = fakeDb({ rpcRows: [] });

    expect(await loadLadder(db, true, THRESHOLD)).toEqual({
      state: 'ok',
      total: 0,
      singlesProvisional: 0,
      doublesProvisional: 0,
    });
    // No ladder is a real answer and it is given directly. `.in('player_id', [])`
    // happens to match nothing, but only by accident of PostgREST's syntax.
    expect(tables).toEqual([]);
  });

  it('withholds without reading anything when the viewer may not see the roster', async () => {
    const { db, rpcCalls, tables } = fakeDb({ rpcRows: roster(31) });

    expect(await loadLadder(db, false, THRESHOLD)).toEqual({ state: 'withheld' });
    // A query that runs for output nobody renders still ships its rows into the
    // RSC payload. That is the leak, not the render.
    expect(rpcCalls).toEqual([]);
    expect(tables).toEqual([]);
  });
});
