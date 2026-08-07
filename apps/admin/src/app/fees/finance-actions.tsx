'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Button, Dialog, Input, Select, DatePicker, useConfirm } from '@badminton/ui';
import {
  resolvePaymentMethod,
  EXPENSE_CATEGORIES,
  OTHER_INCOME_CATEGORIES,
  type ExpenseCategory,
  type OtherIncomeCategory,
} from '@badminton/shared';
import { useToast } from '@/components/toast-provider';
import { addOtherIncome, removeOtherIncome, addExpense, removeExpense } from '@/lib/actions';
import {
  PaymentMethodFields,
  paymentMethodInvalid,
  EMPTY_PAYMENT_METHOD,
  type PaymentMethodState,
} from './payment-method-fields';

/**
 * Dialogs for the two non-fee ledgers (00073).
 *
 * Both entry forms share one shape on purpose — description, category, amount,
 * optional date, optional payment method — because the two tables share one
 * column layout and a future consolidation should not have to reconcile two
 * different ideas of what a money entry is.
 */

/**
 * Dollars typed into a text box -> integer cents.
 *
 * Math.round, not truncation: 19.99 * 100 is 1998.9999999999998 in binary
 * floating point, and |0 would file it as $19.98. Cents are the only integer
 * the database ever sees; the float exists for the length of this function.
 */
function toCents(dollars: string): number | null {
  const n = Number.parseFloat(dollars);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.round(n * 100);
}

/**
 * "YYYY-MM-DD" from the date picker -> a full ISO timestamp.
 *
 * Noon local time, not midnight: midnight in a timezone behind UTC serialises
 * to the previous day, so an expense entered for the 1st would be stored as the
 * last day of the previous month. Nothing buckets by this date — the season is
 * a column — but a receipt dated a day early is still wrong on screen.
 */
function dateToIso(day: string): string | undefined {
  if (!day) return undefined;
  const d = new Date(`${day}T12:00:00`);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}

interface EntryFormState {
  description: string;
  amount: string;
  category: string;
  day: string;
  quantity: string;
}

const emptyForm = (category: string): EntryFormState => ({
  description: '',
  amount: '',
  category,
  day: '',
  quantity: '',
});

/** Shared dialog body. `quantityLabel` present = show the unit-count field. */
function EntryDialog({
  open,
  onClose,
  title,
  intro,
  categories,
  form,
  setForm,
  payment,
  setPayment,
  quantityLabel,
  onSubmit,
  isPending,
  submitLabel,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  intro: React.ReactNode;
  categories: readonly { value: string; label: string }[];
  form: EntryFormState;
  setForm: (next: EntryFormState) => void;
  payment: PaymentMethodState;
  setPayment: (next: PaymentMethodState) => void;
  quantityLabel?: string;
  onSubmit: () => void;
  isPending: boolean;
  submitLabel: string;
}) {
  const cents = toCents(form.amount);
  // Amount is required and must parse. An entry with no figure is not a ledger
  // line, and a blank one submitted as 0 would look like a recorded $0.00.
  const invalid =
    !form.description.trim() || form.amount.trim() === '' || cents === null || paymentMethodInvalid(payment);

  return (
    <Dialog open={open} onClose={onClose} title={title}>
      <div className="space-y-4">
        <p className="text-sm text-[var(--text-secondary)]">{intro}</p>
        <Input
          label="Description"
          value={form.description}
          onChange={(e) => setForm({ ...form, description: e.target.value })}
          placeholder="e.g. 6 tubes of Yonex AS-30"
          maxLength={120}
        />
        <Select
          label="Category"
          options={categories.map((c) => ({ value: c.value, label: c.label }))}
          value={form.category}
          onChange={(e) => setForm({ ...form, category: e.target.value })}
        />
        <Input
          label="Amount $"
          type="number"
          step="0.01"
          min="0"
          value={form.amount}
          onChange={(e) => setForm({ ...form, amount: e.target.value })}
          placeholder="e.g. 84.00"
        />
        {quantityLabel && (
          <Input
            label={quantityLabel}
            type="number"
            step="1"
            min="1"
            value={form.quantity}
            onChange={(e) => setForm({ ...form, quantity: e.target.value })}
            placeholder="e.g. 6"
          />
        )}
        <DatePicker
          label="Date (optional — defaults to today)"
          value={form.day}
          onChange={(day) => setForm({ ...form, day })}
          disabled={isPending}
        />
        <PaymentMethodFields value={payment} onChange={setPayment} disabled={isPending} />
        <div className="flex gap-2">
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          {/* `loading` also disables the button, which is the only thing
              stopping a double-click filing the same spend twice: unlike a
              season fee, two identical expenses on the same day are legitimate,
              so the database has no uniqueness constraint to catch it. */}
          <Button onClick={onSubmit} loading={isPending} disabled={invalid} className="flex-1">
            {submitLabel}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

export function AddOtherIncome({ seasonId, seasonName }: { seasonId: string; seasonName: string }) {
  const DEFAULT_CATEGORY: OtherIncomeCategory = 'donation';
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState<EntryFormState>(emptyForm(DEFAULT_CATEGORY));
  const [payment, setPayment] = useState<PaymentMethodState>(EMPTY_PAYMENT_METHOD);
  const [isPending, startTransition] = useTransition();
  const { toast } = useToast();
  const router = useRouter();

  function handleAdd() {
    const cents = toCents(form.amount);
    if (cents === null) return;
    startTransition(async () => {
      try {
        await addOtherIncome({
          season_id: seasonId,
          category: form.category as OtherIncomeCategory,
          description: form.description.trim(),
          amount_cents: cents,
          paid_at: dateToIso(form.day),
          method: resolvePaymentMethod(payment.method, payment.customMethod),
          reference: payment.reference.trim() || undefined,
        });
        toast('Income recorded', 'success');
        setOpen(false);
        setForm(emptyForm(DEFAULT_CATEGORY));
        setPayment(EMPTY_PAYMENT_METHOD);
        router.refresh();
      } catch (err) {
        toast(err instanceof Error ? err.message : 'Failed to record income', 'error');
      }
    });
  }

  return (
    <>
      <Button variant="ghost" size="sm" onClick={() => setOpen(true)}>Add income</Button>
      <EntryDialog
        open={open}
        onClose={() => setOpen(false)}
        title="Add other income"
        intro={
          <>
            Money in that is not a club, tournament or reinstatement fee — counts toward{' '}
            <strong className="text-[var(--text-primary)]">{seasonName}</strong>.
          </>
        }
        categories={OTHER_INCOME_CATEGORIES}
        form={form}
        setForm={setForm}
        payment={payment}
        setPayment={setPayment}
        onSubmit={handleAdd}
        isPending={isPending}
        submitLabel="Add income"
      />
    </>
  );
}

export function AddExpense({ seasonId, seasonName }: { seasonId: string; seasonName: string }) {
  const DEFAULT_CATEGORY: ExpenseCategory = 'shuttles';
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState<EntryFormState>(emptyForm(DEFAULT_CATEGORY));
  const [payment, setPayment] = useState<PaymentMethodState>(EMPTY_PAYMENT_METHOD);
  const [isPending, startTransition] = useTransition();
  const { toast } = useToast();
  const router = useRouter();

  function handleAdd() {
    const cents = toCents(form.amount);
    if (cents === null) return;
    const qty = form.quantity.trim() === '' ? undefined : Number.parseInt(form.quantity, 10);
    startTransition(async () => {
      try {
        await addExpense({
          season_id: seasonId,
          category: form.category as ExpenseCategory,
          description: form.description.trim(),
          amount_cents: cents,
          quantity: Number.isFinite(qty) ? qty : undefined,
          paid_at: dateToIso(form.day),
          method: resolvePaymentMethod(payment.method, payment.customMethod),
          reference: payment.reference.trim() || undefined,
        });
        toast('Expense recorded', 'success');
        setOpen(false);
        setForm(emptyForm(DEFAULT_CATEGORY));
        setPayment(EMPTY_PAYMENT_METHOD);
        router.refresh();
      } catch (err) {
        toast(err instanceof Error ? err.message : 'Failed to record expense', 'error');
      }
    });
  }

  return (
    <>
      <Button variant="ghost" size="sm" onClick={() => setOpen(true)}>Add expense</Button>
      <EntryDialog
        open={open}
        onClose={() => setOpen(false)}
        title="Add expense"
        intro={
          <>
            Money out — shuttles, court rental, equipment, food. Counts against{' '}
            <strong className="text-[var(--text-primary)]">{seasonName}</strong>.
          </>
        }
        categories={EXPENSE_CATEGORIES}
        form={form}
        setForm={setForm}
        payment={payment}
        setPayment={setPayment}
        quantityLabel="Quantity (optional — e.g. tubes)"
        onSubmit={handleAdd}
        isPending={isPending}
        submitLabel="Add expense"
      />
    </>
  );
}

/**
 * Delete a row from either ledger.
 *
 * Confirmed, unlike RemoveManualFee: these rows are typed by hand and there is
 * no second copy of the number anywhere. The confirm names the amount so a
 * mis-click on the wrong row is visible before it happens.
 */
export function RemoveLedgerEntry({
  id,
  kind,
  label,
  amountCents,
}: {
  id: string;
  kind: 'income' | 'expense';
  label: string;
  amountCents: number;
}) {
  const [isPending, startTransition] = useTransition();
  const { toast } = useToast();
  const router = useRouter();
  const confirm = useConfirm();

  async function handleRemove() {
    const money = `$${(amountCents / 100).toFixed(2)}`;
    const ok = await confirm({
      title: kind === 'income' ? 'Delete income entry?' : 'Delete expense?',
      message: `Delete "${label}" (${money})? This removes it from the season total.`,
      confirmLabel: 'Delete',
    });
    if (!ok) return;
    startTransition(async () => {
      try {
        if (kind === 'income') await removeOtherIncome(id);
        else await removeExpense(id);
        toast('Deleted', 'success');
        router.refresh();
      } catch (err) {
        toast(err instanceof Error ? err.message : 'Failed to delete', 'error');
      }
    });
  }

  return (
    <Button variant="danger" size="sm" onClick={handleRemove} loading={isPending}>
      Delete
    </Button>
  );
}
