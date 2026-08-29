import { describe, it, expect, beforeEach, vi } from 'vitest';

// VOID AND CONVERT MUST NOT REIMPLEMENT IN TYPESCRIPT WHAT SQL NOW OWNS.
//
// This file used to be convert-casual-retry.test.ts, and it asserted the four
// arms of convertMatchToCasual directly: that a retry of a conversion which had
// already reached 'confirmed' did not take the reversal path and leave the match
// voided with the rating pulled back out. Those arms still exist and still
// matter — production holds rows in every one of those partial states — but
// since 00203 they live inside convert_club_match_to_casual, and asserting them
// against a mocked Supabase client would only prove the mock branches the way
// the mock was written.
//
// They are asserted for real instead, against a real database, in
// supabase/tests/00203_conversion_arms.sql — six cases covering all four arms,
// mutation-proven: collapsing arm 1 to an early return, or dropping either half
// of its condition, each fails it loudly.
//
// What is left for THIS layer is the property that makes that possible: the
// server actions delegate and reimplement nothing. The decisive assertion is
// that neither action touches a table at all. A future edit that reintroduces a
// status read "just to decide X" is exactly how the four-arm bug came back the
// first time, and reading the match outside the transaction that mutates it is
// a stale read by construction.

const store = vi.hoisted(() => ({
  rpcs: [] as Array<{ fn: string; args: Record<string, unknown> }>,
  tables: [] as string[],
  audits: [] as Record<string, unknown>[],
  rpcError: null as { message: string } | null,
}));

vi.mock('../supabase-server', () => ({
  createAdminClient: () => ({
    rpc: (fn: string, args: Record<string, unknown>) => {
      store.rpcs.push({ fn, args });
      return Promise.resolve({ data: null, error: store.rpcError });
    },
    // Records the ATTEMPT rather than throwing, so a reintroduced read shows up
    // as a named table in the failure message instead of an opaque mock error.
    from: (table: string) => {
      store.tables.push(table);
      const chain: Record<string, unknown> = {};
      const self = () => chain;
      chain.select = self; chain.eq = self; chain.update = self; chain.upsert = self;
      chain.single = () => Promise.resolve({ data: null, error: null });
      chain.then = (resolve: (v: unknown) => unknown) => resolve({ data: null, error: null });
      return chain;
    },
  }),
}));

vi.mock('./_shared', () => ({}));
vi.mock('../actions/_shared', () => ({
  requireCapability: (cap: string) => Promise.resolve({ id: 'admin-1', cap }),
}));
vi.mock('../audit', () => ({
  logAdminAudit: (_c: unknown, row: Record<string, unknown>) => { store.audits.push(row); return Promise.resolve(); },
}));
vi.mock('next/cache', () => ({ revalidatePath: () => {} }));
vi.mock('@sentry/nextjs', () => ({
  getCurrentScope: () => ({ setExtras: () => {} }),
  captureException: () => {},
}));

const { voidMatch, convertMatchToCasual } = await import('../actions/matches');

const M_ID = '22222222-2222-4222-8222-222222222222';

beforeEach(() => { store.rpcs = []; store.tables = []; store.audits = []; store.rpcError = null; });

describe.each([
  { name: 'voidMatch',            run: voidMatch,            fn: 'void_club_match' },
  { name: 'convertMatchToCasual', run: convertMatchToCasual, fn: 'convert_club_match_to_casual' },
])('$name delegates the whole mutation', ({ run, fn }) => {
  it('makes exactly one RPC call, and it is the transactional one', async () => {
    const r = await run(M_ID, 'a genuine reason');
    expect(r.ok).toBe(true);
    expect(store.rpcs.map((c) => c.fn)).toEqual([fn]);
    expect(store.rpcs[0]!.args).toEqual({
      p_match_id: M_ID,
      p_actor_id: 'admin-1',
      p_reason: 'a genuine reason',
    });
  });

  it('reads and writes no table of its own', async () => {
    await run(M_ID, 'a genuine reason');
    // THE ASSERTION THIS FILE EXISTS FOR. Not "it did the right thing" but
    // "it did nothing else" — no status read to branch on, no separate note
    // write, nothing that could land without the mutation beside it.
    expect(store.tables).toEqual([]);
  });

  it('writes no audit row from here — the transaction writes it', async () => {
    await run(M_ID, 'a genuine reason');
    // A row written here would be a SECOND one, since the SQL function already
    // wrote match_voided / match_converted_casual inside the transaction.
    expect(store.audits).toEqual([]);
  });

  it('reports noteRecorded true, because the note cannot now be missing', async () => {
    const r = await run(M_ID, 'a genuine reason');
    expect(r.ok && r.data.noteRecorded).toBe(true);
  });

  it('surfaces a failed transaction instead of a green toast', async () => {
    store.rpcError = { message: 'Match not found' };
    const r = await run(M_ID, 'a genuine reason');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('Match not found');
    // Nothing landed, so nothing may be claimed. The old shape could return ok
    // with noteRecorded false; this one has no such half-outcome to report.
    expect(store.audits).toEqual([]);
  });
});
