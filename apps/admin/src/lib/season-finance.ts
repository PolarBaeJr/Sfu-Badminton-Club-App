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
 *
 * REIMBURSEMENT (00077) CHANGES NOTHING HERE, ON PURPOSE.
 * An expense counts against the season in full whether or not the exec who
 * fronted it has been paid back. The query below does not read reimbursed_at
 * and must not start: net is an ACCRUAL figure — what the season cost the club
 * — and reimbursing someone is the club settling a debt it already owed, not a
 * new event and not the undoing of an old one. Six tubes of shuttles cost the
 * club $84 the moment they were bought; who was holding the receipt in the
 * meantime is a question about people, not about money.
 *
 * Two concrete things go wrong the other way. The alternative — count only
 * SETTLED expenses, making net a cash-out figure that tracks the bank balance —
 * is genuinely defensible for a treasurer reconciling a statement, and it is
 * what a strict cash basis would do. But:
 *
 *   1. Net would RISE at the moment cash actually left the club. Mark the $84
 *      reimbursed, the club is $84 poorer in the world and $84 richer on the
 *      page. That is the opposite of what the number is for.
 *   2. An unsettled expense would be invisible. The club would read "in the
 *      positives" while owing three execs for shuttles — and "are we in the
 *      positives" is the exact question the club owner asked this page to
 *      answer. A commitment already made has to be in it.
 *
 * So: accrual, and reimbursement is a settlement flag on the row. The cost of
 * choosing this way is that net does not tell you the bank balance; the row
 * list shows which expenses are still owed, which is where that question
 * belongs.
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
  /**
   * EVERY MOVEMENT OF THE CLUB'S MONEY, SIGNED AND DATED — income positive,
   * spending negative — for the net position across the term.
   *
   * Costs nothing: both halves were already fetched for the totals above, and
   * both queries filter `paid_at is not null`, so cumulating this list ends at
   * exactly `netCents`. The curve's last point IS the headline rather than
   * agreeing with it by luck.
   *
   * THE NOTE BELOW USED TO SAY THE OPPOSITE, and it was right at the time: the
   * expense payments were kept out of this object because "they belong to the
   * expense panel and to nothing the net position shows". The net position
   * shows one now. What has NOT changed is the rule underneath that note — this
   * list is untagged, so a holder of `fees.netposition.read` gets the club's
   * net over time and cannot recover any individual ledger from it. See the
   * note on SeasonIncome.payments.
   */
  netPayments: { at: string; cents: number }[];
}

/**
 * The five columns the expense arithmetic touches. Exported because the fold
 * over them is exported — a caller holding rows has to be able to say so.
 */
export interface ExpenseRow {
  amount_cents: number | null;
  category: string | null;
  paid_at: string | null;
  reimbursed_at: string | null;
  paid_by: string | null;
}

/**
 * Money out — the whole of what one read of the expense ledger yields, with no
 * ledger of money IN read at all.
 *
 * FOUR READINGS OF ONE QUERY, not four queries. The dashboard draws the total,
 * the category breakdown, the running total across the term and what the club
 * still owes the people who fronted it, and every one of them is the same set
 * of rows counted a different way. Assembling them here rather than at the call
 * sites is the rule the rest of this file already follows: the last time two
 * surfaces each did their own arithmetic over the club's money they disagreed
 * with reality for months.
 */
export interface SeasonExpenses extends Pick<SeasonFinances, 'expenseCents' | 'expensesByCategory'> {
  /**
   * Every paid row as a dated amount, for the running total. Unsorted — the
   * chart buckets by day and sorts there.
   *
   * The set is the same set `expenseCents` sums, because the query below
   * filters `paid_at is not null`, so the last point of the running total and
   * the headline beside it CANNOT disagree. That is the point of deriving both
   * here instead of adding a second query for the chart.
   */
  payments: { at: string; cents: number }[];
  /**
   * MONEY THE CLUB OWES ITS OWN EXECS: rows somebody paid for out of pocket
   * (`paid_by` set) that have not been reimbursed yet.
   *
   * `paid_by` is required, not just a null `reimbursed_at`. A court booking put
   * on the club's own card has nobody to pay back, and counting it as a debt
   * would tell the treasurer the club owes an exec for the gym.
   *
   * This is NOT netted off anywhere: an expense counts against the season in
   * full whether or not the exec has been paid back — see the note at the top
   * of this file on why net is an accrual figure. This is the other half of
   * that story, and the reason it is worth showing: the accrual total is
   * silent about who is still out of pocket.
   */
  owedToExecsCents: number;
  owedToExecsCount: number;
  /**
   * EVERYTHING SOMEBODY FRONTED, settled or not — every row with `paid_by` set.
   *
   * The denominator `owedToExecsCents` is a part of, and the only honest one:
   * "how much of what our people put in have we paid back" is a real quantity,
   * where "unreimbursed as a share of all spending" is not — a season paid for
   * entirely on the club card would read as 100% settled having settled
   * nothing. Rows with no payer are excluded from BOTH, because a court booking
   * on the club's own card has nobody to pay back.
   *
   * Reimbursed is this minus `owedToExecsCents`, so there is no third sum to
   * disagree with the other two.
   */
  frontedCents: number;
}

/**
 * The expense half on its own.
 *
 * Split out because seeing what the club has SPENT (fees.expenses.read) and
 * seeing what it has TAKEN IN are different permissions — the dashboard draws
 * an expense total for somebody who may see no income ledger and no net
 * position, and calling getSeasonFinances for that figure would read the club's
 * fees, tournament money and reinstatements for a person shown none of them.
 *
 * getSeasonFinances calls this, exactly as it calls getSeasonIncome, so there
 * is still one implementation of the sum and one place net is computed.
 */
export async function getSeasonExpenses(
  supabase: SupabaseClient,
  season: SeasonWindow,
): Promise<SeasonExpenses> {
  const expenses = await supabase
    .from('club_expenses')
    // paid_at, reimbursed_at and paid_by ride along with the two columns the
    // total needs. They are the same ledger under the same capability
    // (fees.expenses.read), so this widens no permission — and fetching them
    // together is what keeps the chart and the headline the same arithmetic.
    .select('amount_cents, category, paid_at, reimbursed_at, paid_by')
    .eq('season_id', season.id)
    .not('paid_at', 'is', null);

  // unwrap, NOT `data ?? []`. A failed expense query read as an empty ledger
  // would make netCents equal income exactly — the club would be reported as
  // maximally in the positives at the precise moment the expense data could not
  // be read. Between this code deploying and 00073 being applied by hand, that
  // query DOES fail, so this is the normal path on the day of the deploy, not a
  // hypothetical.
  return summariseExpenseRows(
    unwrap(expenses as { data: ExpenseRow[] | null; error: { message: string } | null }),
  );
}

/**
 * THE FOUR READINGS, OVER ROWS THAT ARE ALREADY IN HAND.
 *
 * Split out of getSeasonExpenses for the same reason foldLedgerRows was split
 * out of readLedger: /fees' Expenses tab already selects this exact ledger, row
 * by row, to list it — so a chart of what the club spent needs no query at all,
 * only this arithmetic applied to rows the page is holding. Asking the database
 * for club_expenses a second time on the same render, to draw a picture of rows
 * already on screen, is a round trip for nothing.
 *
 * ONE FOLD, TWO CALLERS. A second CALLER of one piece of arithmetic is not what
 * the note at the top of this file forbids; a second piece of arithmetic is.
 * The dashboard's expense figure and /fees' expense chart now come out of the
 * same function over the same columns, so they cannot disagree.
 *
 * IT DOES NOT FILTER ON paid_at. The query above does, and a caller passing
 * rows it fetched without that filter must apply it first — /fees selects
 * unpaid rows too, so it can badge them "not recorded". Moving the filter in
 * here would be harmless for today's two callers and would quietly change what
 * a third one counts.
 */
export function summariseExpenseRows(rows: readonly ExpenseRow[]): SeasonExpenses {
  // One pass: the total, the per-category map, the dated payments and the
  // unreimbursed debt are all built from the same rows, so no reading of this
  // ledger can fail to agree with any other reading of it.
  const byCategory = new Map<string, number>();
  const payments: { at: string; cents: number }[] = [];
  let expenseCents = 0;
  let owedToExecsCents = 0;
  let owedToExecsCount = 0;
  let frontedCents = 0;
  for (const row of rows) {
    const cents = row.amount_cents ?? 0;
    expenseCents += cents;
    // Falls back to 'other' only for display grouping; the row's own amount is
    // already in the total above, so an unrecognised category cannot drop out.
    const key = row.category ?? 'other';
    byCategory.set(key, (byCategory.get(key) ?? 0) + cents);
    // The query filters `paid_at is not null`, so this guard never fires
    // against the real table — it is here so a row that somehow arrives
    // undated is left OFF the time axis rather than being placed at its start,
    // which would move money earlier in the term.
    if (row.paid_at) payments.push({ at: row.paid_at, cents });
    // Both of these ask for a PAYER first. A row the club paid for directly has
    // nobody to pay back, so it is neither a debt nor part of the total that
    // debt is measured against.
    if (row.paid_by) frontedCents += cents;
    if (row.paid_by && !row.reimbursed_at) {
      owedToExecsCents += cents;
      owedToExecsCount += 1;
    }
  }

  const expensesByCategory = [...byCategory.entries()]
    .map(([category, cents]) => ({ category, cents }))
    .sort((a, b) => b.cents - a.cents);

  return {
    expenseCents,
    expensesByCategory,
    payments,
    owedToExecsCents,
    owedToExecsCount,
    frontedCents,
  };
}

export async function getSeasonFinances(
  supabase: SupabaseClient,
  season: SeasonWindow,
): Promise<SeasonFinances> {
  const [income, expenses] = await Promise.all([
    getSeasonIncome(supabase, season),
    getSeasonExpenses(supabase, season),
  ]);

  // Named one field at a time rather than spread. getSeasonExpenses also
  // returns the unreimbursed debt and what execs fronted, which belong to the
  // expense panel and to nothing the net position shows — spreading it would
  // hand every caller of this function fields it has no business drawing.
  //
  // The dated payments ARE taken, and signed as they are taken: SPENDING IS
  // NEGATIVE, which is the whole of the arithmetic behind the net curve. Doing
  // it here rather than at the panel is the same rule the rest of this file
  // follows — the last time a surface did its own sums over the club's money it
  // disagreed with reality for months.
  return {
    income,
    expenseCents: expenses.expenseCents,
    expensesByCategory: expenses.expensesByCategory,
    netCents: income.totalCents - expenses.expenseCents,
    netPayments: [
      ...income.payments,
      ...expenses.payments.map((p) => ({ at: p.at, cents: -p.cents })),
    ],
  };
}
