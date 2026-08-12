import { formatExpenseCategory, formatOtherIncomeCategory } from '@badminton/shared';
import {
  buildBars,
  buildRunningAreaPath,
  buildRunningPath,
  buildRunningTotal,
  buildSplit,
  computeRunningScale,
} from '@/lib/charts';
import { foldLedgerRows, type LedgerAmountRow } from '@/lib/season-income';
import { summariseExpenseRows, type ExpenseRow } from '@/lib/season-finance';
import {
  BarRows,
  ChartFigure,
  ChartNote,
  MICRO,
  RUNNING_BOX,
  RunningTotalChart,
  SplitBar,
  clubDayOf,
  money,
} from '@/components/charts';

/**
 * ONE LEDGER, DRAWN — the chart block at the head of the Expenses and Other
 * income tabs.
 *
 * NO QUERY OF ITS OWN, AND THAT IS THE POINT. LedgerCard has already selected
 * every row of this ledger to list it; these are the same rows folded a
 * different way, through the same functions the dashboard's figures come out of
 * (`summariseExpenseRows`, `foldLedgerRows`). So the headline here, the rows in
 * the table beneath it and the figure on the dashboard are one arithmetic, and
 * drawing the picture costs the page nothing.
 *
 * IT IS RENDERED FROM ROWS AND NEVER FETCHES, so it holds no permission
 * decision at all. The gate is LedgerCard's `canRead`, which decides whether
 * the query runs — a hidden panel whose query still ran has already shipped the
 * club's books into the RSC payload, which is the shape of four live leaks
 * found in this console.
 *
 * PAID ROWS ONLY. LedgerCard deliberately also selects rows with no `paid_at`
 * so it can badge them "not recorded"; those have not left the bank and are not
 * spent money, so the caller filters them out before folding — the same rule,
 * and the same set, the ledger queries in season-finance.ts and season-income.ts
 * apply for themselves. It means the total drawn here is the sum of exactly the
 * rows badged "Counted" below, which a reader can check by eye.
 *
 * WHY THIS IS NOT `LedgerChartPanel` FROM components/dashboard. That component
 * brings its own `Card` and its own link target, and both are wrong here: this
 * block sits INSIDE the ledger card (nesting two cards is the one thing the
 * console's guidance rules out by name), and its href would point /fees at
 * itself. What the two share is the four primitives in @/components/charts,
 * which is where sharing between screens is supposed to happen — see the note
 * at the top of that module.
 */

type LedgerKind = 'income' | 'expense';

/** Every column either fold reads, as LedgerCard already holds them. */
export interface LedgerChartRow extends LedgerAmountRow, Partial<ExpenseRow> {
  amount_cents: number;
  paid_at: string | null;
}

const COPY = {
  income: {
    figureLabel: 'Taken in this season',
    breakdown: 'Where it came from',
    tone: 'var(--color-success)',
    noun: ['payment', 'payments'] as const,
  },
  expense: {
    figureLabel: 'Spent this season',
    breakdown: 'Where it went',
    tone: 'var(--color-danger)',
    noun: ['payment', 'payments'] as const,
  },
};

export function LedgerCharts({
  kind,
  seasonName,
  rows,
}: {
  kind: LedgerKind;
  seasonName: string;
  /** Every row of the ledger, paid or not, exactly as LedgerCard fetched it. */
  rows: readonly LedgerChartRow[];
}) {
  const isIncome = kind === 'income';
  const copy = isIncome ? COPY.income : COPY.expense;
  const paid = rows.filter((row) => row.paid_at);

  // The expense fold carries the reimbursement half with it; the income ledger
  // has no payer and so has no debt to draw. Both return a total, dated
  // payments and a category breakdown.
  const expenses = isIncome ? null : summariseExpenseRows(paid as ExpenseRow[]);
  const ledger = expenses
    ? { total: expenses.expenseCents, payments: expenses.payments, byCategory: expenses.expensesByCategory }
    : foldLedgerRows(paid);

  const points = buildRunningTotal(ledger.payments, clubDayOf);
  const scale = computeRunningScale(points, RUNNING_BOX);
  const bars = buildBars(
    ledger.byCategory.map((part) => ({
      label: (isIncome ? formatOtherIncomeCategory : formatExpenseCategory)(part.category),
      cents: part.cents,
    })),
  );

  // MONEY THE CLUB OWES ITS OWN PEOPLE, as a share of what they put in.
  //
  // Drawn only when somebody has actually fronted something. A split of a zero
  // total renders an empty track rather than nothing at all — SplitBar is the
  // one shape in the kit that does — and "every expense this term went on the
  // club card" is not a fact worth a chart.
  const debt =
    expenses && expenses.frontedCents > 0
      ? buildSplit([
          { label: 'Paid back', value: expenses.frontedCents - expenses.owedToExecsCents },
          { label: 'Still owed', value: expenses.owedToExecsCents },
        ])
      : null;

  // Nothing counted at all. The card underneath already says the ledger is
  // empty in its own words, so this block simply stands down rather than
  // stacking a second empty state on top of the first.
  if (paid.length === 0) return null;

  return (
    <div className="space-y-5 border-b border-[var(--border)] px-4 py-4">
      <ChartFigure label={copy.figureLabel} value={money(ledger.total)} tone={copy.tone} />

      {scale ? (
        <RunningTotalChart
          points={points}
          scale={scale}
          linePath={buildRunningPath(points, scale)}
          areaPath={buildRunningAreaPath(points, scale)}
          tone={copy.tone}
          noun={copy.noun}
          label={`${copy.figureLabel} for ${seasonName}: ${money(ledger.total)} across ${points.length} days, running total.`}
        />
      ) : (
        <ChartNote>
          Everything recorded so far landed on one day, so there is no line to draw yet. A
          running total needs two.
        </ChartNote>
      )}

      {/* TWO CATEGORIES OR MORE. buildBars measures every row against the
          largest, so a ledger with one category draws a single full-width bar
          beside a figure identical to the headline three inches above it — a
          chart that restates a number already on the screen, which is the
          definition of noise. Nothing is lost: the one category is on every row
          of the table below. */}
      {bars.length > 1 && (
        <div className="space-y-3 border-t border-[var(--border)] pt-4">
          <p className={MICRO}>{copy.breakdown}</p>
          {/* One tone for the set. Differentiation is the labels — five hues in
              a flat console is five new colour values. */}
          <BarRows rows={bars} tone={copy.tone} />
        </div>
      )}

      {debt && (
        <div className="space-y-3 border-t border-[var(--border)] pt-4">
          <p className={MICRO}>Out of pocket</p>
          {/* A REAL PART OF A WHOLE: paid back plus still owed IS what the
              club's people have fronted between them. Measured against that and
              not against all spending — a season paid for entirely on the club
              card would otherwise read as fully settled having settled nothing.

              Not netted off anything. An expense counts against the season in
              full whether or not the person who fronted it has been paid back;
              see the accrual note in lib/season-finance.ts. This is the other
              half of that story, and the only place the console says it beside
              the control that settles it. */}
          <SplitBar
            split={debt}
            tones={['var(--color-success)', 'var(--color-warning)']}
            format={money}
          />
          <p className="text-xs text-[var(--text-muted)]">
            {expenses!.owedToExecsCount === 0
              ? 'Everybody who bought something for the club has been paid back.'
              : `${expenses!.owedToExecsCount} ${
                  expenses!.owedToExecsCount === 1 ? 'expense is' : 'expenses are'
                } still unreimbursed. The season is charged for them either way.`}
          </p>
        </div>
      )}
    </div>
  );
}
