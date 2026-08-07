import type { SupabaseClient } from '@supabase/supabase-js';
import { unwrap } from '@badminton/shared';
import { getSeasonIncome, type SeasonIncome, type SeasonWindow } from './season-income';

/**
 * The whole financial picture for one season: everything in, everything out,
 * and the difference.
 *
 * The club owner's actual question was "are we in the positives" — which needs
 * both halves in one place. This is the ONLY place net is computed. Two pages
 * (/fees and /dashboard) show the figure, and the last time two pages each
 * summed the money themselves they agreed on being wrong for months: the income
 * headline counted club_fees only, so recorded reinstatement and tournament
 * payments read as $0.00. Adding a page that shows net means adding a caller of
 * this function, never a second sum.
 *
 * Income comes from getSeasonIncome — this wraps it rather than reimplementing
 * it, so a new income ledger has exactly one place to be added and reaches
 * every net figure automatically. (other_income was added THERE, not here, for
 * that reason.) getSeasonIncome now has exactly one caller, this function, and
 * both pages that show money call this one.
 *
 * Expenses follow the same season rule as income: a real season_id column, not
 * a date window. reinstatement_fees was bucketed by paid_at and money paid
 * between terms fell outside every window and disappeared from every total
 * (00069). A shuttle order placed in August for a September season would land
 * in exactly the same hole.
 *
 * And the same paid_at rule: an expense row with no paid_at has not left the
 * bank yet, so it is not spent money. It is shown in the expense list marked
 * "not recorded" — deliberately visible rather than silently dropped, because
 * the failure mode of a filtered total is a row nobody knows is missing.
 */
export interface SeasonFinances {
  /** Every income ledger, itemised. `income.totalCents` is money in. */
  income: SeasonIncome;
  /** Money out: club_expenses rows for this season with paid_at set. */
  expenseCents: number;
  /** Money out per category, for the breakdown. Only categories with spend. */
  expensesByCategory: { category: string; cents: number }[];
  /**
   * income.totalCents - expenseCents. Negative means the club is in the red.
   * Signed on purpose: clamping at zero would hide the one answer the club
   * owner asked for.
   */
  netCents: number;
}

interface ExpenseRow {
  amount_cents: number | null;
  category: string | null;
}

export async function getSeasonFinances(
  supabase: SupabaseClient,
  season: SeasonWindow,
): Promise<SeasonFinances> {
  const [income, expenses] = await Promise.all([
    getSeasonIncome(supabase, season),
    supabase
      .from('club_expenses')
      .select('amount_cents, category')
      .eq('season_id', season.id)
      .not('paid_at', 'is', null),
  ]);

  // unwrap, NOT `data ?? []`. A failed expense query read as an empty ledger
  // would make netCents equal income exactly — the club would be reported as
  // maximally in the positives at the precise moment the expense data could not
  // be read. Between this code deploying and 00073 being applied by hand, that
  // query DOES fail, so this is the normal path on the day of the deploy, not a
  // hypothetical.
  const rows = unwrap(
    expenses as { data: ExpenseRow[] | null; error: { message: string } | null },
  );

  // One pass: the per-category map and the total are built from the same rows,
  // so the breakdown can never fail to add up to the headline.
  const byCategory = new Map<string, number>();
  let expenseCents = 0;
  for (const row of rows) {
    const cents = row.amount_cents ?? 0;
    expenseCents += cents;
    // Falls back to 'other' only for display grouping; the row's own amount is
    // already in the total above, so an unrecognised category cannot drop out.
    const key = row.category ?? 'other';
    byCategory.set(key, (byCategory.get(key) ?? 0) + cents);
  }

  const expensesByCategory = [...byCategory.entries()]
    .map(([category, cents]) => ({ category, cents }))
    .sort((a, b) => b.cents - a.cents);

  return {
    income,
    expenseCents,
    expensesByCategory,
    netCents: income.totalCents - expenseCents,
  };
}
