import type { SupabaseClient } from '@supabase/supabase-js';
import { getClubFeeIncome, getOtherIncome } from './season-income';
import { getSeasonExpenses } from './season-finance';

/**
 * THE DASHBOARD'S FINANCE FIGURES, FETCHED ONE CAPABILITY AT A TIME.
 *
 * The dashboard's net-position card asks for fees.netposition.read and reads
 * every ledger the club has. The per-ledger tiles beside it cannot do that:
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

/** A figure is null when it was not asked for — nothing was fetched for it. */
export interface DashboardFinances {
  season: ActiveSeason;
  expenseCents: number | null;
  clubFeeCents: number | null;
  otherIncomeCents: number | null;
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
  // Nothing is fetched for somebody who may see none of the three. The tiles are
  // the only reason this function exists.
  if (!wants.expenses && !wants.clubFees && !wants.otherIncome) return null;
  if (!season) return null;

  const [expenses, clubFeeCents, otherIncomeCents] = await Promise.all([
    wants.expenses ? getSeasonExpenses(supabase, season) : null,
    wants.clubFees ? getClubFeeIncome(supabase, season) : null,
    wants.otherIncome ? getOtherIncome(supabase, season) : null,
  ]);

  return {
    season,
    expenseCents: expenses?.expenseCents ?? null,
    clubFeeCents,
    otherIncomeCents,
  };
}
