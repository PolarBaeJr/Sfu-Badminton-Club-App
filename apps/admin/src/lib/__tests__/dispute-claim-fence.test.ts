import { describe, it, expect, beforeEach, vi } from 'vitest';

// A RETRY MUST NOT RESOLVE A DISPUTE THE OTHER WAY.
//
// The unrated branch of resolveDispute is three steps: claim the dispute, mutate
// the match, close the dispute. The failure that matters lands between two and
// three — the match is already converted to casual, the close fails, and the
// admin retries. Before 00192 the claim bound only WHO was resolving, so the
// retry could come back as Void and be granted; voidMatch has no precondition on
// the match's classification, so it re-marked a casual match as voided and the
// club's record of that match became whichever attempt ran last.
//
// The fence lives in claim_dispute_for_resolution, which now records the
// resolution the claim was taken for and refuses a different one. These tests
// are about the APPLICATION half of that: that it sends the resolution at all,
// and that on a refusal it performs NO match mutation. The database half is
// asserted in 00192's own verifier and was exercised directly against staging.
//
// The assertions are on whether voidMatch/convertMatchToCasual RAN, not on the
// message. A version that threw after mutating the match would pass a
// throw-only test and leave the defect exactly where it was.

const store = vi.hoisted(() => ({
  claimResult: {} as Record<string, unknown>,
  rpcCalls: [] as Array<{ fn: string; args: Record<string, unknown> }>,
  voided: [] as string[],
  casualed: [] as string[],
  closes: 0,
}));

vi.mock('../supabase-server', () => ({
  createAdminClient: () => ({
    rpc: (fn: string, args: Record<string, unknown>) => {
      store.rpcCalls.push({ fn, args });
      return Promise.resolve({ data: store.claimResult, error: null });
    },
    from: () => {
      const chain: Record<string, unknown> = {};
      const self = () => chain;
      chain.update = () => { store.closes++; return chain; };
      chain.eq = self;
      chain.select = () => Promise.resolve({ data: [{ id: D_ID }], error: null });
      return chain;
    },
  }),
}));

vi.mock('./_shared', () => ({}));
vi.mock('../actions/_shared', () => ({
  requireCapability: () => Promise.resolve({ id: 'admin-1' }),
}));
vi.mock('../actions/matches', () => ({
  voidMatch: (id: string) => { store.voided.push(id); return Promise.resolve({ ok: true }); },
  convertMatchToCasual: (id: string) => { store.casualed.push(id); return Promise.resolve({ ok: true }); },
}));
vi.mock('../audit', () => ({ logAdminAudit: () => Promise.resolve() }));
vi.mock('next/cache', () => ({ revalidatePath: () => {} }));

const { resolveDispute } = await import('../actions/disputes');

// Real UUIDs: disputeResolveSchema validates the shape before any of this runs,
// so a placeholder id fails at parseOrThrow and every assertion below about the
// match being untouched would pass for the wrong reason.
const D_ID = '11111111-1111-4111-8111-111111111111';

const CLAIM_OK = {
  claimed: true, already_resolved: false, held_by_other: false,
  type_conflict: false, claimed_resolution_type: 'converted_to_casual', match_id: 'm1',
};
const CLAIM_CONFLICT = {
  claimed: false, already_resolved: false, held_by_other: false,
  type_conflict: true, claimed_resolution_type: 'converted_to_casual', match_id: 'm1',
};

beforeEach(() => {
  store.rpcCalls = []; store.voided = []; store.casualed = []; store.closes = 0;
});

describe('the dispute claim binds its resolution', () => {
  it('sends the resolution it is claiming for', async () => {
    store.claimResult = CLAIM_OK;
    await resolveDispute({ dispute_id: D_ID, resolution_type: 'converted_to_casual', resolution_note: 'a genuine reason' } as never);
    const claim = store.rpcCalls.find(c => c.fn === 'claim_dispute_for_resolution');
    expect(claim).toBeDefined();
    // Without this argument the database function refuses the claim outright,
    // so an app that stopped sending it would fail closed rather than silently
    // regress — but it would still be broken, and this is what says so.
    expect(claim!.args.p_resolution_type).toBe('converted_to_casual');
    expect(store.casualed).toEqual(['m1']);
  });

  it('performs NO match mutation when the claim reports a conflicting resolution', async () => {
    store.claimResult = CLAIM_CONFLICT;
    const r = await resolveDispute({ dispute_id: D_ID, resolution_type: 'voided', resolution_note: 'a genuine reason' } as never);
    expect(r.ok).toBe(false);
    // The whole finding in one line: the match must be untouched.
    expect(store.voided).toEqual([]);
    expect(store.casualed).toEqual([]);
    expect(store.closes).toBe(0);
  });

  it('names the resolution already recorded, so the operator can retry as that', async () => {
    store.claimResult = CLAIM_CONFLICT;
    const r = await resolveDispute({ dispute_id: D_ID, resolution_type: 'voided', resolution_note: 'a genuine reason' } as never);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('converted_to_casual');
  });
});
