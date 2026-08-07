import { createAdminClient } from '@/lib/supabase-server';
import { Badge, Card, EmptyState, ResponsiveTable, TableCard, Atomic } from '@badminton/ui';
import {
  unwrap,
  formatPaymentMethod,
  formatExpenseCategory,
  formatOtherIncomeCategory,
  formatExpenseRef,
  formatOtherIncomeRef,
} from '@badminton/shared';
import {
  AddOtherIncome,
  AddExpense,
  EditExpense,
  RemoveLedgerEntry,
  MarkReimbursed,
} from './finance-actions';

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
 *
 * REIMBURSEMENT STATE (00077) IS SHOWN TO EVERYONE WHO CAN SEE THE ROW,
 * including execs — that is the whole point of the feature for them: an exec
 * who bought shuttles out of pocket comes here to find out whether the club has
 * paid them back. Only an admin gets the button that changes it, and only an
 * admin gets Delete.
 */

type LedgerKind = 'income' | 'expense';

interface LedgerRow {
  id: string;
  /** Database-assigned counter behind EXP-0001 / INC-0001 (00077). */
  ref_no: number | null;
  category: string | null;
  description: string;
  amount_cents: number;
  quantity?: number | null;
  paid_at: string | null;
  paid_by?: string | null;
  reimbursed_at?: string | null;
  reimbursed_by?: string | null;
  method: string | null;
  reference: string | null;
  created_at: string;
}

const INCOME_COLS = 'id, ref_no, category, description, amount_cents, paid_at, method, reference, created_at';
const EXPENSE_COLS = `${INCOME_COLS}, quantity, paid_by, reimbursed_at, reimbursed_by`;

const money = (cents: number) => `$${(cents / 100).toFixed(2)}`;

/** Local date only — the time of day a shuttle order was paid is noise. */
const day = (iso: string | null) =>
  iso ? new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) : '-';

export async function LedgerCard({
  kind,
  seasonId,
  seasonName,
  isAdmin,
}: {
  kind: LedgerKind;
  seasonId: string;
  seasonName: string;
  /**
   * Admins settle and delete; execs record and read. Passed in rather than
   * re-derived here so the page is the single place that decides — and note it
   * only picks which CONTROLS are offered. Every action re-gates itself, since
   * the client that runs them is service-role and bypasses RLS.
   */
  isAdmin: boolean;
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

  // Names for the payer / confirmer ids, in ONE lookup.
  //
  // Not a PostgREST embed: club_expenses now has three foreign keys to players
  // (marked_by, paid_by, reimbursed_by), and an embed across an ambiguous
  // relationship fails outright with "more than one relationship was found"
  // unless every one is disambiguated by constraint name. A plain `.in()` on
  // the ids the rows actually carry is shorter, cannot break when a fourth FK
  // is added, and fetches at most a handful of rows.
  const peopleIds = isIncome
    ? []
    : [...new Set(rows.flatMap((r) => [r.paid_by, r.reimbursed_by]).filter((v): v is string => !!v))];
  const nameById = new Map<string, string>();
  if (peopleIds.length > 0) {
    const people = unwrap(
      await supabase.from('players').select('id, full_name').in('id', peopleIds),
    ) as unknown as { id: string; full_name: string }[];
    for (const p of people) nameById.set(p.id, p.full_name);
  }
  // Falls back to "someone" rather than to an empty string: a row reading
  // "Reimbursed" with no name looks settled to nobody, and a deleted player is
  // exactly when this matters.
  const nameOf = (id: string | null | undefined) => (id ? nameById.get(id) ?? 'someone' : null);

  // Who may be named as having fronted an expense: the people who can be in a
  // shop buying shuttles for the club. Execs and admins only — the same set the
  // console admits — because anyone else has no way to be reimbursed through
  // this page. NOT fetched for the income ledger, which has no payer.
  const payerOptions = isIncome
    ? []
    : (unwrap(
        await supabase
          .from('players')
          .select('id, full_name')
          .or('role.eq.admin,is_exec.eq.true')
          .order('full_name'),
      ) as unknown as { id: string; full_name: string }[]);

  const formatCategory = isIncome ? formatOtherIncomeCategory : formatExpenseCategory;
  // EXP-0001 / INC-0001. Formatting lives in @badminton/shared so the table, a
  // toast and the audit trail cannot spell the same row three ways.
  const formatRef = isIncome ? formatOtherIncomeRef : formatExpenseRef;

  /**
   * The three states of an expense's money, in words.
   *
   * "Club funds" is a real answer, not a missing one: paid_by IS NULL means the
   * club account paid directly and there is nobody to reimburse (00077's
   * club_expenses_reimbursement_needs_payer CHECK enforces that no such row can
   * ever be marked reimbursed). Showing it explicitly is what stops an exec
   * reading a blank as "they forgot about me".
   */
  const reimbursement = (row: LedgerRow) => {
    if (isIncome) return null;
    if (!row.paid_by) {
      return { variant: 'neutral' as const, label: 'Club funds', detail: null };
    }
    const payer = nameOf(row.paid_by);
    if (row.reimbursed_at) {
      return { variant: 'success' as const, label: `Reimbursed ${payer}`, detail: day(row.reimbursed_at) };
    }
    return { variant: 'warning' as const, label: `Owed to ${payer}`, detail: null };
  };

  const heading = isIncome ? 'Other income' : 'Expenses';
  const blurb = isIncome
    ? 'Donations, grants, socials and anything else that is money in but not a fee.'
    : 'Money out. Shuttles, court rental, equipment and food, for this season.';

  const subLine = (row: LedgerRow) => {
    const parts = [formatRef(row.ref_no), formatCategory(row.category), day(row.paid_at)];
    if (!isIncome && row.quantity != null) parts.push(`×${row.quantity}`);
    return parts.filter(Boolean).join(' · ');
  };

  /** The props EditExpense needs, straight off the row. Expenses only. */
  const editable = (row: LedgerRow) => ({
    id: row.id,
    ref: formatRef(row.ref_no),
    category: row.category ?? 'other',
    description: row.description,
    amount_cents: row.amount_cents,
    quantity: row.quantity ?? null,
    paid_at: row.paid_at,
    paid_by: row.paid_by ?? null,
    reimbursed_at: row.reimbursed_at ?? null,
    method: row.method,
    reference: row.reference,
  });

  return (
    <Card padding={false}>
      <div className="px-4 pt-4 flex items-start justify-between gap-4">
        <div>
          <h2 className="text-sm font-medium text-[var(--text-primary)]">{heading}</h2>
          <p className="text-xs text-[var(--text-muted)]">{blurb}</p>
        </div>
        {isIncome ? (
          <AddOtherIncome seasonId={seasonId} seasonName={seasonName} />
        ) : (
          <AddExpense seasonId={seasonId} seasonName={seasonName} payerOptions={payerOptions} />
        )}
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
          cards={rows.map((row) => {
            const reimb = reimbursement(row);
            return (
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
                <>
                  <Badge variant={row.paid_at ? 'success' : 'warning'}>
                    {row.paid_at ? 'Counted' : 'Not recorded'}
                  </Badge>
                  {reimb && <Badge variant={reimb.variant}>{reimb.label}</Badge>}
                </>
              }
              fields={[
                { label: 'Method', value: row.method ? formatPaymentMethod(row.method) : '-' },
                {
                  label: 'Reference',
                  value: row.reference ? <Atomic className="font-mono text-xs">{row.reference}</Atomic> : '-',
                },
                ...(reimb?.detail ? [{ label: 'Reimbursed', value: reimb.detail }] : []),
              ]}
              actions={
                <>
                  {/* Settling and deleting are admin work. An exec sees the
                      state — that is the point of the feature for them — and no
                      control that would reject them. */}
                  {isAdmin && !isIncome && (
                    <EditExpense expense={editable(row)} payerOptions={payerOptions} />
                  )}
                  {isAdmin && !isIncome && row.paid_by && !row.reimbursed_at && (
                    <MarkReimbursed
                      id={row.id}
                      payerName={nameOf(row.paid_by)!}
                      amountCents={row.amount_cents}
                    />
                  )}
                  {isAdmin && (
                    <RemoveLedgerEntry id={row.id} kind={kind} label={row.description} amountCents={row.amount_cents} />
                  )}
                </>
              }
            />
            );
          })}
        >
          <table className="w-full">
            <thead>
              <tr className="border-b border-[var(--border)]">
                {/* The reference the club owner asked for: something a person
                    can read off a receipt and match to a row. First column
                    because that is how it will be used — scanned down, not
                    hunted for. */}
                <th className="px-4 py-3 text-left text-xs font-medium text-[var(--text-muted)] uppercase">Ref</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-[var(--text-muted)] uppercase">Entry</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-[var(--text-muted)] uppercase">Category</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-[var(--text-muted)] uppercase">Date</th>
                <th className="px-4 py-3 text-right text-xs font-medium text-[var(--text-muted)] uppercase">Amount</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-[var(--text-muted)] uppercase">Method</th>
                {/* Expenses only — the income ledger has no payer to pay back.
                    Header and cell are gated on the same flag so the column
                    counts cannot drift apart. */}
                {!isIncome && (
                  <th className="px-4 py-3 text-left text-xs font-medium text-[var(--text-muted)] uppercase">Paid by</th>
                )}
                <th className="px-4 py-3 text-right text-xs font-medium text-[var(--text-muted)] uppercase">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--border)]">
              {rows.map((row) => {
                const reimb = reimbursement(row);
                return (
                <tr key={row.id} className="hover:bg-[var(--border-hover)] transition-colors">
                  <td className="px-4 py-3">
                    <Atomic className="font-mono text-xs text-[var(--text-muted)]">{formatRef(row.ref_no)}</Atomic>
                  </td>
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
                  {!isIncome && reimb && (
                    <td className="px-4 py-3 text-sm">
                      <Badge variant={reimb.variant}>{reimb.label}</Badge>
                      {reimb.detail && (
                        <span className="block text-xs text-[var(--text-muted)] mt-1">{reimb.detail}</span>
                      )}
                    </td>
                  )}
                  <td className="px-4 py-3 text-right">
                    <div className="flex items-center justify-end gap-2">
                      {isAdmin && !isIncome && (
                        <EditExpense expense={editable(row)} payerOptions={payerOptions} />
                      )}
                      {isAdmin && !isIncome && row.paid_by && !row.reimbursed_at && (
                        <MarkReimbursed
                          id={row.id}
                          payerName={nameOf(row.paid_by)!}
                          amountCents={row.amount_cents}
                        />
                      )}
                      {isAdmin && (
                        <RemoveLedgerEntry
                          id={row.id}
                          kind={kind}
                          label={row.description}
                          amountCents={row.amount_cents}
                        />
                      )}
                    </div>
                  </td>
                </tr>
                );
              })}
            </tbody>
          </table>
        </ResponsiveTable>
      )}
    </Card>
  );
}
