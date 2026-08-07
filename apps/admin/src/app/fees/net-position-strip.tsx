import { Card } from '@badminton/ui';
import { formatExpenseCategory } from '@badminton/shared';
import type { SeasonFinances } from '@/lib/season-finance';

/**
 * "Are we in the positives?" — the club owner's actual question, answered at
 * the top of the money page whichever tab is open.
 *
 * Presentational only. Every figure comes from the SeasonFinances object the
 * page already fetched; nothing here sums a row. Two pages independently
 * summing money is how the income figure came to read $0.00 while the money sat
 * in the database, and a component that does its own arithmetic is a third.
 */

const money = (cents: number) => `$${(Math.abs(cents) / 100).toFixed(2)}`;

export function NetPositionStrip({
  finances,
  seasonName,
}: {
  finances: SeasonFinances;
  seasonName: string;
}) {
  const { income, expenseCents, expensesByCategory, netCents } = finances;
  const inTheRed = netCents < 0;

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <Card>
          <p className="text-xs text-[var(--text-muted)] uppercase">Income</p>
          <p className="text-2xl font-bold font-mono text-[var(--color-success)]">{money(income.totalCents)}</p>
          <p className="text-xs text-[var(--text-muted)] mt-1">
            Fees, tournaments, reinstatements and other income
          </p>
        </Card>
        <Card>
          <p className="text-xs text-[var(--text-muted)] uppercase">Expenses</p>
          <p className="text-2xl font-bold font-mono text-[var(--color-danger)]">-{money(expenseCents)}</p>
          <p className="text-xs text-[var(--text-muted)] mt-1">Shuttles, courts, equipment, food</p>
        </Card>
        {/* The headline. A minus sign is easy to miss at a glance, so the label
            says which side of zero this is in words as well. */}
        <Card className={inTheRed ? 'border-[var(--color-danger)]' : 'border-[var(--color-success)]'}>
          <p className="text-xs text-[var(--text-muted)] uppercase">Net · {seasonName}</p>
          <p
            className={`text-2xl font-bold font-mono ${
              inTheRed ? 'text-[var(--color-danger)]' : 'text-[var(--color-success)]'
            }`}
          >
            {inTheRed ? '-' : ''}
            {money(netCents)}
          </p>
          <p className="text-xs text-[var(--text-muted)] mt-1">
            {inTheRed ? 'Spending more than the club has taken in' : 'In the positives'}
          </p>
        </Card>
      </div>

      {/* Where the money went. Rendered from the same rows that produced the
          expense total, so the parts always add up to the whole. */}
      {expensesByCategory.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {expensesByCategory.map(({ category, cents }) => (
            <span
              key={category}
              className="text-xs px-2 py-1 rounded-full bg-[var(--bg-elevated)] text-[var(--text-secondary)]"
            >
              {formatExpenseCategory(category)}{' '}
              <span className="font-mono text-[var(--text-muted)]">{money(cents)}</span>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
