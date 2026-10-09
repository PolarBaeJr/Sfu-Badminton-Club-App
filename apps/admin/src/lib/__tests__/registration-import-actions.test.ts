// The console's Google Form actions (00283). Every parameter is a client POST
// field, so: a malformed id is refused before anything is read, the capability
// asked for is the one the STORED row implies (never what the client says),
// and a non-member fee action refuses any row that is not a named tournament
// fee.

import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@sentry/nextjs', () => ({ captureException: vi.fn(), captureMessage: vi.fn() }));

const capabilities: string[] = [];
vi.mock('../actions/_shared', () => ({
  requireCapability: vi.fn(async (capability: string) => {
    capabilities.push(capability);
    return { id: 'admin-1' };
  }),
}));
const audits: { action_type: string }[] = [];
vi.mock('../audit', () => ({
  logAdminAudit: vi.fn(async (_client: unknown, entry: { action_type: string }) => {
    audits.push(entry);
  }),
}));

let rows: Record<string, Record<string, unknown> | null>;
const rpcs: { fn: string; args: unknown }[] = [];
const updates: { table: string; values: unknown }[] = [];
let reads = 0;

vi.mock('../supabase-server', () => ({
  createAdminClient: () => ({
    from: (table: string) => {
      const chain: Record<string, unknown> = {};
      let mode: 'select' | 'update' = 'select';
      Object.assign(chain, {
        select: () => chain,
        eq: () => chain,
        is: () => chain,
        insert: (values: unknown) => {
          updates.push({ table, values });
          mode = 'update';
          return chain;
        },
        update: (values: unknown) => {
          updates.push({ table, values });
          mode = 'update';
          return chain;
        },
        maybeSingle: async () => {
          reads += 1;
          return { data: mode === 'update' ? { id: 'new-id' } : (rows[table] ?? null), error: null };
        },
        then: (resolve: (value: unknown) => void) => resolve({ data: [{ id: 'row' }], error: null }),
      });
      return chain;
    },
    rpc: async (fn: string, args: unknown) => {
      rpcs.push({ fn, args });
      return { data: { ok: true }, error: null };
    },
  }),
}));

const actions = await import('../actions/registration-imports');

const ENTRY = '11111111-1111-4111-8111-111111111111';
const EVENT = '22222222-2222-4222-8222-222222222222';
const TOURNAMENT = '33333333-3333-4333-8333-333333333333';
const CONSUMER = '44444444-4444-4444-8444-444444444444';

beforeEach(() => {
  capabilities.length = 0;
  audits.length = 0;
  rpcs.length = 0;
  updates.length = 0;
  reads = 0;
  rows = {};
});

describe('form registration actions', () => {
  it('refuses a malformed id before reading or asking for a capability', async () => {
    for (const result of [
      await actions.undoImportedEntry('not-a-uuid'),
      await actions.setRegistrationFormActive("1' OR 1=1", false),
      await actions.markNonMemberFeePaid('x', 'cash'),
      await actions.markNonMemberFeeUnpaid(''),
    ]) {
      expect(result.ok).toBe(false);
    }
    expect(reads).toBe(0);
    expect(capabilities).toEqual([]);
  });

  it('refuses a binding body with an unknown field or a bad form id', async () => {
    const base = {
      targetKind: 'tournament' as const,
      targetId: TOURNAMENT,
      consumerId: CONSUMER,
      formId: 'form_1',
      joinWaitlist: false,
      soloDoublesAck: false,
    };
    expect((await actions.bindRegistrationForm({ ...base, formId: 'bad id with spaces' })).ok).toBe(false);
    expect((await actions.bindRegistrationForm({ ...base, created_by: 'someone' } as never)).ok).toBe(false);
    expect(capabilities).toEqual([]);
  });

  it('binds with the capability of the target kind, and audits it', async () => {
    rows = { club_events: { id: EVENT }, data_api_consumers: { id: CONSUMER } };
    const result = await actions.bindRegistrationForm({
      targetKind: 'club_event',
      targetId: EVENT,
      consumerId: CONSUMER,
      formId: 'form_1',
      joinWaitlist: false,
      soloDoublesAck: false,
    });
    expect(result.ok).toBe(true);
    expect(capabilities).toEqual(['events.manage.update.write']);
    expect(audits.map((a) => a.action_type)).toEqual(['registration_form_bound']);
  });

  it('asks the remove capability the stored entry implies', async () => {
    rows = { registration_import_entries: { id: ENTRY, tournament_event_id: EVENT, club_event_id: null, pair_id: 'p1', status: 'entered' }, tournament_events: { tournament_id: TOURNAMENT } };
    expect((await actions.undoImportedEntry(ENTRY)).ok).toBe(true);
    expect(capabilities).toEqual(['tournaments.draw.pairs.remove.write']);
    expect(rpcs).toEqual([{ fn: 'undo_registration_import_entry', args: { p_entry_id: ENTRY, p_actor: 'admin-1' } }]);

    capabilities.length = 0;
    rows = { registration_import_entries: { id: ENTRY, tournament_event_id: null, club_event_id: EVENT, pair_id: null, status: 'entered' } };
    expect((await actions.undoImportedEntry(ENTRY)).ok).toBe(true);
    expect(capabilities).toEqual(['events.signups.remove.write']);
  });

  it('settles only a named tournament fee, never a member fee or dues', async () => {
    rows = { club_fees: { id: ENTRY, tournament_id: TOURNAMENT, manual_name: null, fee_type: 'tournament', paid_at: null } };
    expect((await actions.markNonMemberFeePaid(ENTRY, 'cash')).ok).toBe(false);
    rows = { club_fees: { id: ENTRY, tournament_id: null, manual_name: 'Guest', fee_type: 'dues', paid_at: null } };
    expect((await actions.markNonMemberFeePaid(ENTRY, 'cash')).ok).toBe(false);
    expect(updates).toEqual([]);

    rows = { club_fees: { id: ENTRY, tournament_id: TOURNAMENT, manual_name: 'Guest', fee_type: 'tournament', paid_at: null, amount_cents: 2500 } };
    expect((await actions.markNonMemberFeePaid(ENTRY, 'waived')).ok).toBe(false);
    expect((await actions.markNonMemberFeePaid(ENTRY, 'cash')).ok).toBe(true);
    expect(audits.map((a) => a.action_type)).toEqual(['tournament_fee_marked_paid']);
  });
});
