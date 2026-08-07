import { createAdminClient } from '@/lib/supabase-server';
import { Badge, Card, EmptyState, ResponsiveTable, TableCard, Atomic } from '@badminton/ui';
import {
  unwrap,
  formatPaymentMethod,
  formatExpenseCategory,
  formatOtherIncomeCategory,
} from '@badminton/shared';
import { AddOtherIncome, AddExpense, RemoveLedgerEntry } from './finance-actions';

/**
 * The row list for one of the two non-fee ledgers (00073).
 *
 * DELIBERATELY SHOWS NO SUBTOTAL. The season's money figures come from
 * getSeasonFinances and nowhere else. A card that summed its own rows would be
 * a second implementation of the same total sitting inches from the first, and
 * the two would disagree the moment one of them changed — which is exactly how
 * the income headline came to read $0.00 while money sat in the database. The
 * list answers "what is in here"; the strip at the top of the page answers
 * "how much".
 *
 * A row with no paid_at is excluded from those totals, so it is badged "Not
 * recorded" here rather than looking identical to a counted row. A filtered-out
 * row that looks the same as a counted one is a row nobody knows is missing.
 */

type LedgerKind = 'income' | 'expense';

interface LedgerRow {
  id: string;
  category: string | null;
  description: string;
  amount_cents: number;
  quantity?: number | null;
  paid_at: string | null;
  method: string | null;
  reference: string | null;
  created_at: string;
}

const INCOME_COLS = 'id, category, description, amount_cents, paid_at, method, reference, created_at';
const EXPENSE_COLS = `${INCOME_COLS}, quantity`;

const money = (cents: number) => `$${(cents / 100).toFixed(2)}`;

/** Local date only — the time of day a shuttle order was paid is noise. */
const day = (iso: string | null) =>
  iso ? new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) : '-';

export async function LedgerCard({
  kind,
  seasonId,
  seasonName,
}: {
  kind: LedgerKind;
  seasonId: string;
  seasonName: string;
}) {
  const supabase = createAdminClient();
  const isIncome = kind === 'income';
  const table = isIncome ? 'other_income' : 'club_expenses';

  // season_id is NOT NULL on both tables (00073), so unlike the reinstatement
  // card there is no "attached to no season" bucket to sweep up: every row
  // belongs to exactly one season and this query cannot miss one.
  const rows = unwrap(
    await supabase
      .from(table)
      .select(isIncome ? INCOME_COLS : EXPENSE_COLS)
      .eq('season_id', seasonId)
      .order('paid_at', { ascending: false, nullsFirst: true })
      .order('created_at', { ascending: false }),
  ) as unknown as LedgerRow[];

  const formatCategory = isIncome ? formatOtherIncomeCategory : formatExpenseCategory;
  const AddButton = isIncome ? AddOtherIncome : AddExpense;

  const heading = isIncome ? 'Other income' : 'Expenses';
  const blurb = isIncome
    ? 'Donations, grants, socials and anything else that is money in but not a fee.'
    : 'Money out. Shuttles, court rental, equipment and food, for this season.';

  const subLine = (row: LedgerRow) => {
    const parts = [formatCategory(row.category), day(row.paid_at)];
    if (!isIncome && row.quantity != null) parts.push(`×${row.quantity}`);
    return parts.filter(Boolean).join(' · ');
  };

  return (
    <Card padding={false}>
      <div className="px-4 pt-4 flex items-start justify-between gap-4">
        <div>
          <h2 className="text-sm font-medium text-[var(--text-primary)]">{heading}</h2>
          <p className="text-xs text-[var(--text-muted)]">{blurb}</p>
        </div>
        <AddButton seasonId={seasonId} seasonName={seasonName} />
      </div>

      {rows.length === 0 ? (
        <EmptyState
          title={isIncome ? 'No other income recorded' : 'No expenses recorded'}
          description={
            isIncome
              ? `Nothing beyond fees has been recorded for ${seasonName} yet.`
              : `Nothing has been recorded as spent in ${seasonName} yet.`
          }
        />
      ) : (
        <ResponsiveTable
          cards={rows.map((row) => (
            <TableCard
              key={row.id}
              title={
                <div className="min-w-0">
                  <p className="text-sm font-medium text-[var(--text-primary)]">{row.description}</p>
                  <p className="text-xs font-normal text-[var(--text-muted)]">{subLine(row)}</p>
                </div>
              }
              value={`${isIncome ? '' : '-'}${money(row.amount_cents)}`}
              badges={
                <Badge variant={row.paid_at ? 'success' : 'warning'}>
                  {row.paid_at ? 'Counted' : 'Not recorded'}
                </Badge>
              }
              fields={[
                { label: 'Method', value: row.method ? formatPaymentMethod(row.method) : '-' },
                {
                  label: 'Reference',
                  value: row.reference ? <Atomic className="font-mono text-xs">{row.reference}</Atomic> : '-',
                },
              ]}
              actions={
                <RemoveLedgerEntry id={row.id} kind={kind} label={row.description} amountCents={row.amount_cents} />
              }
            />
          ))}
        >
          <table className="w-full">
            <thead>
              <tr className="border-b border-[var(--border)]">
                <th className="px-4 py-3 text-left text-xs font-medium text-[var(--text-muted)] uppercase">Entry</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-[var(--text-muted)] uppercase">Category</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-[var(--text-muted)] uppercase">Date</th>
                <th className="px-4 py-3 text-right text-xs font-medium text-[var(--text-muted)] uppercase">Amount</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-[var(--text-muted)] uppercase">Method</th>
                <th className="px-4 py-3 text-right text-xs font-medium text-[var(--text-muted)] uppercase">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--border)]">
              {rows.map((row) => (
                <tr key={row.id} className="hover:bg-[var(--border-hover)] transition-colors">
                  <td className="px-4 py-3">
                    <p className="text-sm font-medium text-[var(--text-primary)]">{row.description}</p>
                    {!row.paid_at && (
                      <Badge variant="warning">Not recorded</Badge>
                    )}
                  </td>
                  <td className="px-4 py-3 text-sm text-[var(--text-secondary)]">
                    {formatCategory(row.category)}
                    {!isIncome && row.quantity != null && (
                      <span className="block text-xs text-[var(--text-muted)]">×{row.quantity}</span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-sm text-[var(--text-secondary)]">{day(row.paid_at)}</td>
                  <td className="px-4 py-3 text-right">
                    <span
                      className={`font-mono ${isIncome ? 'text-[var(--color-success)]' : 'text-[var(--color-danger)]'}`}
                    >
                      {isIncome ? '' : '-'}
                      {money(row.amount_cents)}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-sm text-[var(--text-secondary)]">
                    {row.method ? formatPaymentMethod(row.method) : '-'}
                    {row.reference && (
                      <span className="block font-mono text-xs text-[var(--text-muted)]">{row.reference}</span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-right">
                    <RemoveLedgerEntry
                      id={row.id}
                      kind={kind}
                      label={row.description}
                      amountCents={row.amount_cents}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </ResponsiveTable>
      )}
    </Card>
  );
}
