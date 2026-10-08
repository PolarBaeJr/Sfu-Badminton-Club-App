import { describe, it, expect } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { getOutstandingClubFees } from '../fees-outstanding';

// HOW MUCH THE CLUB IS STILL OWED.
//
// /fees prints a COUNT of people and the dashboard prints an AMOUNT, so the
// predicate that decides whether somebody has settled has to be one piece of
// code. What is pinned here is that predicate, and in particular the two ways a
// row settles: a real payment, and a WAIVER — which is stored as a paid row
// with amount_cents 0 and method 'waived', so it carries paid_at and would be
// billed twice by anybody who only looked at the amount.

const SEASON = { id: 'season-1', competitive_fee_cents: 4000, recreational_fee_cents: 2500 };

type Row = Record<string, unknown>;

function makeClient(rows: Record<string, Row[]>) {
  const tables: string[] = [];
  const client = {
    from(table: string) {
      tables.push(table);
      const api = {
        select: () => api,
        in: () => api,
        eq: () => api,
        not: () => api,
        then: (resolve: (value: unknown) => unknown) =>
          Promise.resolve({ data: rows[table] ?? [], error: null }).then(resolve),
      };
      return api;
    },
  };
  return { supabase: client as unknown as SupabaseClient, tables };
}

const ROSTER: Row[] = [
  { id: 'a', status: 'competitive' },
  { id: 'b', status: 'competitive' },
  { id: 'c', status: 'recreational' },
  { id: 'd', status: 'recreational' },
];

describe('outstanding club fees', () => {
  it('bills every unpaid member at the price for their status', async () => {
    const { supabase } = makeClient({ players: ROSTER, club_fees: [] });
    // 4000 + 4000 + 2500 + 2500
    expect(await getOutstandingClubFees(supabase, SEASON)).toBe(13000);
  });

  it('drops a member who has paid', async () => {
    const { supabase } = makeClient({
      players: ROSTER,
      club_fees: [{ player_id: 'a', paid_at: '2026-08-01T00:00:00Z', method: 'etransfer' }],
    });
    expect(await getOutstandingClubFees(supabase, SEASON)).toBe(9000);
  });

  // THE ROW THAT LOOKS UNPAID AND IS NOT. amount_cents 0 with method 'waived'
  // is how a waiver is recorded, and treating it as a debt would bill somebody
  // the club has already excused.
  it('drops a member whose fee was waived', async () => {
    const { supabase } = makeClient({
      players: ROSTER,
      club_fees: [{ player_id: 'c', paid_at: '2026-08-01T00:00:00Z', method: 'waived' }],
    });
    expect(await getOutstandingClubFees(supabase, SEASON)).toBe(10500);
  });

  // A row exists but nobody has paid against it yet — the member still owes.
  it('still bills a member with an unpaid row on file', async () => {
    const { supabase } = makeClient({
      players: ROSTER,
      club_fees: [{ player_id: 'b', paid_at: null, method: null }],
    });
    expect(await getOutstandingClubFees(supabase, SEASON)).toBe(13000);
  });

  // Manual fees carry manual_name and a null player_id. They must not be
  // matched to a member, and they must not crash the lookup.
  it('ignores manual fee rows that belong to no member', async () => {
    const { supabase } = makeClient({
      players: ROSTER,
      club_fees: [{ player_id: null, paid_at: '2026-08-01T00:00:00Z', method: 'cash' }],
    });
    expect(await getOutstandingClubFees(supabase, SEASON)).toBe(13000);
  });

  it('is zero when everybody has settled', async () => {
    const { supabase } = makeClient({
      players: ROSTER,
      club_fees: [
        { player_id: 'a', paid_at: '2026-08-01T00:00:00Z', method: 'cash' },
        { player_id: 'b', paid_at: '2026-08-01T00:00:00Z', method: 'waived' },
        { player_id: 'c', paid_at: '2026-08-01T00:00:00Z', method: 'etransfer' },
        { player_id: 'd', paid_at: '2026-08-01T00:00:00Z', method: 'cash' },
      ],
    });
    expect(await getOutstandingClubFees(supabase, SEASON)).toBe(0);
  });

  // Only the two tables the figure is made of. A dashboard cell that reached
  // into another book would be the leak the fetch gating exists to prevent.
  it('reads the roster and the club-fee ledger and nothing else', async () => {
    const { supabase, tables } = makeClient({ players: ROSTER, club_fees: [] });
    await getOutstandingClubFees(supabase, SEASON);
    expect(new Set(tables)).toEqual(new Set(['players', 'club_fees']));
  });

  // A failed query must not read as "nobody owes anything". unwrap() throws.
  it('throws rather than reporting a plausible wrong total', async () => {
    const client = {
      from: () => {
        const api = {
          select: () => api,
          in: () => api,
          eq: () => api,
          then: (resolve: (value: unknown) => unknown) =>
            Promise.resolve({ data: null, error: { message: 'relation does not exist' } }).then(resolve),
        };
        return api;
      },
    } as unknown as SupabaseClient;
    await expect(getOutstandingClubFees(client, SEASON)).rejects.toThrow();
  });
});
