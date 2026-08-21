import type { SupabaseClient } from '@supabase/supabase-js';
import { getClubFeeLedger, getOtherIncomeLedger, type LedgerRead } from './season-income';
import { getSeasonExpenses, type SeasonExpenses } from './season-finance';

/**
 * THE DASHBOARD'S FINANCE FIGURES, FETCHED ONE CAPABILITY AT A TIME.
 *
 * The dashboard's net-position card asks for fees.netposition.read and reads
 * every ledger the club has. The per-ledger panels beside it cannot do that:
 * each is behind its own read, and the whole point of those reads is that
 * somebody may hold one and not the others. A card that is hidden but whose
 * query still ran is the leak this file exists to avoid — see the note beside
 * showFinances in dashboard/page.tsx, and the same shape in fees/page.tsx.
 *
 * So the mapping from "what may this person see" to "what do we ask the
 * database for" lives here, in one small function with a test on it, rather
 * than inline in a page component that nothing can render in a unit test. WHICH
 * CAPABILITY EACH FLAG COMES FROM stays with the other gates in the page: this
 * module is handed booleans and never asks the permission model anything, so it
 * cannot become a second, disagreeing answer to who may see club money.
 *
 * IT NOW RETURNS ROWS, NOT JUST TOTALS, because the panels draw charts. That
 * changes nothing about the gating and it adds no query: each ledger's dates
 * and categories come back from the read that was already being made for its
 * total, and the total is computed over those same rows — so a chart's last
 * point and the figure printed beside it cannot drift apart. What it must NOT
 * become is a convenience that fetches everything and lets the page choose; the
 * flags below are still the whole contract.
 */
export interface LedgerFigures {
  /** fees.expenses.read */
  expenses: boolean;
  /** fees.clubfees.read */
  clubFees: boolean;
  /** fees.otherincome.read */
  otherIncome: boolean;
}

/** The active season, as the dashboard already has it in hand. */
export interface ActiveSeason {
  id: string;
  name: string;
}

/** A ledger is null when it was not asked for — nothing was fetched for it. */
export interface DashboardFinances {
  season: ActiveSeason;
  /** club_ledger, direction 'expense': total, categories, dated payments, and what execs are owed. */
  expenses: SeasonExpenses | null;
  /** club_fees where fee_type = 'dues'. Entry fees and reinstatements are other capabilities' books. */
  clubFees: LedgerRead | null;
  /** club_ledger, direction 'income': donations, grants, socials. */
  otherIncome: LedgerRead | null;
}

/**
 * THE SEASON IS PASSED IN, NOT LOOKED UP.
 *
 * This used to select the active season for itself, which was a second round
 * trip for a row the caller was already holding: the dashboard reads `seasons`
 * once near the top of the page — it needs the name for the header eyebrow
 * whatever else it renders — and then called in here, which read it again.
 *
 * `null` means the club has no active season. The ledgers are all keyed by
 * season_id, so there is nothing to add up and nothing worth asking for, and
 * the answer is the same null the caller used to get from the lookup.
 */
export async function getDashboardFinances(
  supabase: SupabaseClient,
  season: ActiveSeason | null,
  wants: LedgerFigures,
): Promise<DashboardFinances | null> {
  // Nothing is fetched for somebody who will be shown none of the three. The
  // panels are the only reason this function exists.
  if (!wants.expenses && !wants.clubFees && !wants.otherIncome) return null;
  if (!season) return null;

  const [expenses, clubFees, otherIncome] = await Promise.all([
    wants.expenses ? getSeasonExpenses(supabase, season) : null,
    wants.clubFees ? getClubFeeLedger(supabase, season) : null,
    wants.otherIncome ? getOtherIncomeLedger(supabase, season) : null,
  ]);

  return { season, expenses, clubFees, otherIncome };
}
