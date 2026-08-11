import { describe, it, expect } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { getDashboardFinances } from '../dashboard-finance';

// WHICH LEDGERS ARE ACTUALLY QUERIED, per capability.
//
// The rule the money pages follow is that a hidden card whose query still ran
// has already shipped the figure — so "gated" has to mean the fetch, not the
// JSX. That claim is untestable while the mapping lives inline in a server
// component, so it lives in one function and this file asserts the only thing
// worth asserting about it: WHICH TABLES WERE TOUCHED.
//
// The tables named below are the club's separate books. Someone holding
// fees.expenses.read may see what the club has spent and nothing about what it
// has taken in, so club_fees, other_income, tournament_fees and
// reinstatement_fees must not be read on their behalf at all — and it is the
// composite helpers (getSeasonFinances, getSeasonIncome) that would read them,
// which is why the per-ledger entry points exist.
//
// `seasons` NO LONGER APPEARS IN THESE LISTS, and that is the point rather than
// a relaxation: the dashboard reads the active season once at the top of the
// page for the header eyebrow, and this function was selecting it a second time.
// It is handed in now. Every claim below about which BOOKS are opened is
// unchanged — the only table that left the assertions is the one that stopped
// being fetched.

const SEASON = { id: 'season-1', name: 'Fall 2026' };

/** A Supabase stand-in that records every table asked for. */
function makeClient(rows: Record<string, { amount_cents: number | null }[]>) {
  const tables: string[] = [];
  const client = {
    from(table: string) {
      tables.push(table);
      const api = {
        select: () => api,
        eq: () => api,
        not: () => api,
        maybeSingle: async () => ({ data: null, error: null }),
        then: (resolve: (value: unknown) => unknown) =>
          Promise.resolve({ data: rows[table] ?? [], error: null }).then(resolve),
      };
      return api;
    },
  };
  return { supabase: client as unknown as SupabaseClient, tables };
}

const LEDGERS = {
  club_expenses: [{ amount_cents: 8400 }, { amount_cents: 1600 }],
  club_fees: [{ amount_cents: 2000 }],
  other_income: [{ amount_cents: 15000 }],
  tournament_fees: [{ amount_cents: 500 }],
  reinstatement_fees: [{ amount_cents: 2500 }],
};

describe('the dashboard finance fetch', () => {
  // THE FINANCE ROLE, which is the whole reason this exists: fees.page,
  // fees.expenses.read and fees.expenses.add.write, and no claim on any book
  // but the expense one.
  it('reads only the expense ledger for somebody who may only see expenses', async () => {
    const { supabase, tables } = makeClient(LEDGERS);

    const finances = await getDashboardFinances(supabase, SEASON, {
      expenses: true,
      clubFees: false,
      otherIncome: false,
    });

    expect(tables).toEqual(['club_expenses']);
    expect(finances?.expenseCents).toBe(10000);
    // Not zero — nothing was asked for, so there is no figure to have.
    expect(finances?.clubFeeCents).toBeNull();
    expect(finances?.otherIncomeCents).toBeNull();
  });

  it('reads only the club fee ledger for somebody who may only see club fees', async () => {
    const { supabase, tables } = makeClient(LEDGERS);

    const finances = await getDashboardFinances(supabase, SEASON, {
      expenses: false,
      clubFees: true,
      otherIncome: false,
    });

    expect(tables).toEqual(['club_fees']);
    expect(finances?.clubFeeCents).toBe(2000);
    expect(finances?.expenseCents).toBeNull();
  });

  it('reads only the other-income ledger for somebody who may only see it', async () => {
    const { supabase, tables } = makeClient(LEDGERS);

    const finances = await getDashboardFinances(supabase, SEASON, {
      expenses: false,
      clubFees: false,
      otherIncome: true,
    });

    expect(tables).toEqual(['other_income']);
    expect(finances?.otherIncomeCents).toBe(15000);
  });

  // Even holding all three tiles' reads is not the net position, which is its
  // own capability over its own set of books: tournament money and
  // reinstatements belong to it and must stay unread here.
  it('never reads the ledgers behind the net position', async () => {
    const { supabase, tables } = makeClient(LEDGERS);

    await getDashboardFinances(supabase, SEASON, { expenses: true, clubFees: true, otherIncome: true });

    expect(tables).not.toContain('tournament_fees');
    expect(tables).not.toContain('reinstatement_fees');
    expect([...tables].sort()).toEqual(['club_expenses', 'club_fees', 'other_income']);
  });

  // The season the figures are labelled with is the caller's, not one this
  // function went and found for itself. A second lookup could in principle
  // disagree with the header eyebrow above it.
  it('labels the figures with the season it was handed, without asking for one', async () => {
    const { supabase, tables } = makeClient(LEDGERS);

    const finances = await getDashboardFinances(supabase, SEASON, {
      expenses: true,
      clubFees: false,
      otherIncome: false,
    });

    expect(finances?.season).toEqual(SEASON);
    expect(tables).not.toContain('seasons');
  });

  // A viewer with no tile is a viewer with no query — including when a season
  // was handed in, because holding the row is not a reason to open a book.
  it('asks the database nothing at all when no ledger may be seen', async () => {
    const { supabase, tables } = makeClient(LEDGERS);

    const finances = await getDashboardFinances(supabase, SEASON, {
      expenses: false,
      clubFees: false,
      otherIncome: false,
    });

    expect(finances).toBeNull();
    expect(tables).toEqual([]);
  });

  // Between terms there is no season to total, and the ledgers are keyed by
  // season_id — so there is nothing to add up and nothing to ask for. The
  // question moved from "did the lookup find one" to "did the caller have one";
  // the answer this function gives is the one it always gave, and it now costs
  // nothing to give it.
  it('reads no ledger at all when the club has no active season', async () => {
    const { supabase, tables } = makeClient(LEDGERS);

    const finances = await getDashboardFinances(supabase, null, {
      expenses: true,
      clubFees: true,
      otherIncome: true,
    });

    expect(finances).toBeNull();
    expect(tables).toEqual([]);
  });
});
