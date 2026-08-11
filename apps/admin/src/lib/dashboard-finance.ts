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

/** A figure is null when it was not asked for — nothing was fetched for it. */
export interface DashboardFinances {
  season: { id: string; name: string };
  expenseCents: number | null;
  clubFeeCents: number | null;
  otherIncomeCents: number | null;
}

export async function getDashboardFinances(
  supabase: SupabaseClient,
  wants: LedgerFigures,
): Promise<DashboardFinances | null> {
  // Not even the season is looked up for somebody who may see none of the
  // three. The tiles are the only reason this page needs one.
  if (!wants.expenses && !wants.clubFees && !wants.otherIncome) return null;

  const { data: season } = await supabase
    .from('seasons')
    .select('id, name')
    .eq('active_flag', true)
    .maybeSingle<{ id: string; name: string }>();
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
