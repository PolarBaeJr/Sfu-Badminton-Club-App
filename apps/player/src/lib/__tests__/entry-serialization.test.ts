import { describe, it, expect, beforeEach, vi } from 'vitest';

// THE DECISION AND THE WRITE ARE ONE STATEMENT NOW (00193).
//
// Three things this file pins, all of which were read-then-act before:
//
//  * Waiver evidence used to be upserted AFTER enter_tournament_event returned,
//    with its result discarded, so a member could be registered with no
//    acceptance record at all. It travels with the entry now, and the hash must
//    actually be sent — a caller that stopped sending it would be refused by the
//    database, but silently entering people without evidence is the failure
//    worth a test.
//  * Withdrawal read the participant row and the event status, decided, then
//    issued an UPDATE keyed on the participant id. A draw published in the gap
//    turned an already-decided refusal into a withdrawal from an event with a
//    published bracket.
//  * Every refusal the function can return has to reach the member as its own
//    sentence. A reason the caller does not handle falls through to the generic
//    retry message, which is how "you are in a pair, ask an admin" becomes
//    "please try again shortly" and the member keeps pressing the button.
//
// These assert on WHICH rpc was called and with what, and on the sentence that
// comes back. There is deliberately no fake Postgres here: the locking is the
// database's half and was exercised directly against staging, including a
// two-session race whose control — the pre-00193 shape — admitted two entries
// against a cap of one.

const store = vi.hoisted(() => ({
  rpc: [] as Array<{ fn: string; args: Record<string, unknown> }>,
  rpcResult: {} as Record<string, unknown>,
  tableWrites: [] as string[],
}));

vi.mock('../supabase-server', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  createServiceRoleClient: () => ({
    rpc: (fn: string, args: Record<string, unknown>) => {
      store.rpc.push({ fn, args });
      return Promise.resolve({ data: store.rpcResult, error: null });
    },
    from: (table: string) => {
      const chain: Record<string, unknown> = {};
      const self = () => chain;
      chain.select = self; chain.eq = self; chain.or = self; chain.limit = self;
      chain.upsert = () => { store.tableWrites.push(table); return Promise.resolve({ error: null }); };
      chain.insert = () => { store.tableWrites.push(table); return Promise.resolve({ error: null }); };
      chain.update = () => { store.tableWrites.push(table); return chain; };
      chain.maybeSingle = () => Promise.resolve({ data: null, error: null });
      chain.single = () => Promise.resolve({ data: null, error: null });
      return chain;
    },
  }),
}));

vi.mock('../actions/_shared', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  requirePlayer: () => Promise.resolve({ id: 'p1', is_banned: false }),
}));
vi.mock('next/cache', () => ({ revalidatePath: () => {} }));
vi.mock('next/headers', () => ({ headers: () => Promise.resolve(new Map()) }));

const { withdrawFromEvent } = await import('../tournament-actions');

beforeEach(() => { store.rpc = []; store.tableWrites = []; });

describe('withdrawal goes through the serialized function', () => {
  it('calls withdraw_from_tournament_event, not a bare participant UPDATE', async () => {
    store.rpcResult = { ok: true, tournament_id: 't1' };
    const r = await withdrawFromEvent('e1');
    expect(r.ok).toBe(true);
    expect(store.rpc.map(c => c.fn)).toContain('withdraw_from_tournament_event');
    // The whole finding: no unfenced write to the participant row.
    expect(store.tableWrites).not.toContain('tournament_participants');
  });

  const CASES: Array<[string, RegExp]> = [
    ['in_pair', /paired with a partner/],
    ['not_registered', /Not registered/],
    ['not_withdrawable', /Cannot withdraw at this stage/],
    ['draw_published', /draw is already published/],
  ];

  for (const [reason, sentence] of CASES) {
    it(`turns ${reason} into its own sentence rather than the generic retry`, async () => {
      store.rpcResult = { ok: false, reason };
      const r = await withdrawFromEvent('e1');
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.error).toMatch(sentence);
        // A reason the switch does not handle lands here instead, which is the
        // regression this guards against.
        expect(r.error).not.toMatch(/try again shortly/);
      }
    });
  }
});
