import { describe, it, expect, beforeEach, vi } from 'vitest';

// ONE DISPUTE RESOLUTION, ONE TRANSACTION, ONE AUDIT ROW.
//
// This file used to be dispute-claim-fence.test.ts. It asserted that the
// unrated branch claimed the dispute before touching the match, and that a
// retry arriving as a DIFFERENT resolution was refused before any mutation —
// because the branch was four separate round trips (claim, mutate, close,
// audit) and a death between any two of them left a partial resolution behind.
//
// 00203 removed the gaps rather than guarding them. resolve_dispute_unrated
// holds the dispute row FOR UPDATE from before it reads the status until it
// commits, so the claim's job is done by the lock, and the mutation, the match
// note, the dispute close and the audit row all land together or not at all.
// claim_dispute_for_resolution is no longer called; the type_conflict and
// held_by_other messages described states that are now unreachable.
//
// WHAT REPLACES THOSE ASSERTIONS. The database half is proven against a real
// database in supabase/tests/00203_conversion_arms.sql: both resolutions apply
// once, a second call is a complete no-op, and after TWO calls there is exactly
// one dispute_resolved row and one match audit row.
//
// The half that belongs here is the one the database cannot see: WHERE the
// audit row is written. The unrated branch must write none from TypeScript,
// because its transaction already wrote it; the rated branch must still write
// exactly one, because resolve_dispute_rated does not. That is a per-branch
// count, and it is asserted per-branch below — a shared call after the if/else
// suppressed by a flag returned from SQL is precisely the shape that yields two
// rows or zero the first time someone misreads it, invisibly.

const store = vi.hoisted(() => ({
  rpcs: [] as Array<{ fn: string; args: Record<string, unknown> }>,
  tables: [] as string[],
  audits: [] as Record<string, unknown>[],
  outcome: { applied: true, already_resolved: false } as Record<string, unknown>,
}));

vi.mock('../supabase-server', () => ({
  createAdminClient: () => ({
    rpc: (fn: string, args: Record<string, unknown>) => {
      store.rpcs.push({ fn, args });
      return Promise.resolve({ data: store.outcome, error: null });
    },
    from: (table: string) => {
      store.tables.push(table);
      const chain: Record<string, unknown> = {};
      const self = () => chain;
      chain.update = self; chain.eq = self; chain.insert = self;
      chain.select = () => Promise.resolve({ data: [{ id: D_ID }], error: null });
      return chain;
    },
  }),
}));

vi.mock('./_shared', () => ({}));
vi.mock('../actions/_shared', () => ({
  requireCapability: () => Promise.resolve({ id: 'admin-1' }),
}));
vi.mock('../audit', () => ({
  logAdminAudit: (_c: unknown, row: Record<string, unknown>) => { store.audits.push(row); return Promise.resolve(); },
}));
vi.mock('next/cache', () => ({ revalidatePath: () => {} }));
vi.mock('@sentry/nextjs', () => ({
  getCurrentScope: () => ({ setExtras: () => {} }),
  captureException: () => {},
}));

const { resolveDispute } = await import('../actions/disputes');

// A real UUID: disputeResolveSchema validates the shape before any of this runs,
// so a placeholder id fails at parseOrThrow and every assertion below about the
// dispute being untouched would pass for the wrong reason.
const D_ID = '11111111-1111-4111-8111-111111111111';

const resolve = (resolution_type: string) =>
  resolveDispute({ dispute_id: D_ID, resolution_type, resolution_note: 'a genuine reason' } as never);

beforeEach(() => {
  store.rpcs = []; store.tables = []; store.audits = [];
  store.outcome = { applied: true, already_resolved: false };
});

describe.each(['voided', 'converted_to_casual'])('the unrated branch (%s)', (kind) => {
  it('makes exactly one RPC call, and it is the transactional one', async () => {
    const r = await resolve(kind);
    expect(r.ok).toBe(true);
    expect(store.rpcs.map((c) => c.fn)).toEqual(['resolve_dispute_unrated']);
    expect(store.rpcs[0]!.args).toEqual({
      p_dispute_id: D_ID,
      p_actor_id: 'admin-1',
      p_resolution_type: kind,
      p_resolution_note: 'a genuine reason',
    });
  });

  it('no longer claims the dispute first — the row lock does that', async () => {
    await resolve(kind);
    expect(store.rpcs.map((c) => c.fn)).not.toContain('claim_dispute_for_resolution');
  });

  it('closes the dispute inside the transaction, not with its own UPDATE', async () => {
    await resolve(kind);
    // The old branch closed the dispute from here, fenced on claimed_by. A
    // table touched from this branch again would be a write outside the
    // transaction that performed the resolution.
    expect(store.tables).toEqual([]);
  });

  it('writes NO audit row from here, because its transaction wrote one', async () => {
    await resolve(kind);
    expect(store.audits).toEqual([]);
  });

  it('reports an already-resolved dispute without pretending it acted', async () => {
    store.outcome = { applied: false, already_resolved: true };
    const r = await resolve(kind);
    expect(r.ok).toBe(true);
    expect(store.audits).toEqual([]);
  });
});

describe('the rated branch still audits from TypeScript', () => {
  it('writes exactly one dispute_resolved row', async () => {
    const r = await resolve('accepted');
    expect(r.ok).toBe(true);
    expect(store.rpcs.map((c) => c.fn)).toEqual(['resolve_dispute_rated']);
    // THE CROSS-BRANCH CENSUS. Unrated writes 0 here and 1 in SQL; rated writes
    // 1 here and 0 in SQL. Both add to exactly one row per resolution, and this
    // pair of counts is what catches the branch placement being got wrong in
    // either direction.
    expect(store.audits).toHaveLength(1);
    expect(store.audits[0]!.action_type).toBe('dispute_resolved');
    expect(store.audits[0]!.target_id).toBe(D_ID);
  });

  it('writes no audit row when the dispute was already resolved', async () => {
    store.outcome = { applied: false, already_resolved: true };
    const r = await resolve('accepted');
    expect(r.ok).toBe(true);
    expect(store.audits).toEqual([]);
  });
});
