'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button, Dialog } from '@badminton/ui';
import { resolvePaymentMethod } from '@badminton/shared';
import { useToast } from '@/components/toast-provider';
import { SelectionBar, SelectionSummary, useSelection } from '@/components/selection';
import { describeBulkOutcome, useBulkRun } from '@/components/use-bulk-run';
import { bulkMarkFeesPaid, bulkMarkFeesUnpaid, bulkWaiveFees } from '@/lib/actions';
import { countEligible, type FeeRowState } from '@/lib/fee-bulk-eligibility';
import {
  PaymentMethodFields,
  paymentMethodInvalid,
  EMPTY_PAYMENT_METHOD,
  type PaymentMethodState,
} from './payment-method-fields';

/**
 * The season fee, settled for several members at once.
 *
 * THE CASE THIS EXISTS FOR is the first night of a term. A queue at the door
 * hands over cash, and the console had one dialog per person — with the same
 * "cash" in the method box every time.
 *
 * NO AMOUNT FIELD, AND THAT IS THE WHOLE DESIGN. bulkMarkFeesPaid deliberately
 * omits amount_cents, so markFeePaid falls back to the season's per-status fee
 * for each member — competitive or recreational, read off their own row. One
 * shared Amount box here would bill thirty people one number and overwrite
 * thirty real prices, and the audit rows would agree with it. A custom amount is
 * a statement about one person and stays in that person's row dialog. Method and
 * transaction id ARE shared and are offered, because "cash, collected at the
 * door" is one sentence about the whole queue.
 *
 * THREE BUTTONS, ONE SELECTION, THREE DIFFERENT ELIGIBLE STATES. Mark Paid and
 * Waive want an unpaid row; Mark Unpaid reverses a paid or waived one. `states`
 * is what lets each dialog say how many of the selection it will really touch,
 * and it is used for nothing else — see lib/fee-bulk-eligibility. Every selected
 * id is sent and the server refuses the rest per record, by name.
 */
export function BulkFeeActions({
  seasonId,
  seasonName,
  states,
  canMarkPaid,
  canWaive,
  canMarkUnpaid,
}: {
  seasonId: string;
  seasonName: string;
  /** Each selectable row's current state, keyed by PLAYER id. A snapshot. */
  states: Record<string, FeeRowState>;
  canMarkPaid: boolean;
  canWaive: boolean;
  canMarkUnpaid: boolean;
}) {
  const router = useRouter();
  const { toast } = useToast();
  const { selectedItems, clear } = useSelection();
  const { running, progress, run } = useBulkRun();

  const [paidOpen, setPaidOpen] = useState(false);
  const [payment, setPayment] = useState<PaymentMethodState>(EMPTY_PAYMENT_METHOD);
  // The two confirmations that collect nothing share a dialog, the shape
  // BulkSessionActions uses for its own destructive pair.
  const [mode, setMode] = useState<'waive' | 'unpaid' | null>(null);

  if (!canMarkPaid && !canWaive && !canMarkUnpaid) return null;

  const ids = selectedItems.map((i) => i.id);
  const nameOf = (id: string) => selectedItems.find((i) => i.id === id)?.label ?? id;
  const busy = running ? `${progress?.done ?? 0} of ${progress?.total ?? ids.length}…` : null;

  const willMarkPaid = countEligible(ids, states, 'markPaid');
  const willWaive = countEligible(ids, states, 'waive');
  const willMarkUnpaid = countEligible(ids, states, 'markUnpaid');

  // "4 of the 9 selected" — and the remainder said out loud rather than left for
  // the officer to find in the toast afterwards.
  const scope = (eligible: number, whatTheRestAre: string) =>
    eligible === ids.length
      ? `All ${ids.length} selected.`
      : `${eligible} of the ${ids.length} selected. The other ${ids.length - eligible} ${
          ids.length - eligible === 1 ? 'is' : 'are'
        } ${whatTheRestAre}, and will be refused by name rather than changed.`;

  async function handleMarkPaid() {
    const result = await run(ids, (chunk) =>
      bulkMarkFeesPaid(
        chunk,
        seasonId,
        resolvePaymentMethod(payment.method, payment.customMethod),
        payment.reference.trim() || undefined,
      ),
    );
    setPaidOpen(false);
    setPayment(EMPTY_PAYMENT_METHOD);
    router.refresh();
    if (!result.ok) {
      toast(result.error ?? 'Something went wrong', 'error');
    } else {
      const { message, type } = describeBulkOutcome(result.outcome, 'marked paid', nameOf);
      toast(message, type);
    }
    clear();
  }

  async function handleConfirm() {
    const waiving = mode === 'waive';
    const result = await run(ids, (chunk) =>
      waiving ? bulkWaiveFees(chunk, seasonId) : bulkMarkFeesUnpaid(chunk, seasonId),
    );
    setMode(null);
    router.refresh();
    if (!result.ok) {
      toast(result.error ?? 'Something went wrong', 'error');
    } else {
      const { message, type } = describeBulkOutcome(
        result.outcome,
        waiving ? 'waived' : 'marked unpaid',
        nameOf,
      );
      toast(message, type);
    }
    clear();
  }

  return (
    <>
      <SelectionBar noun="member">
        {canMarkPaid && (
          <Button
            variant="secondary"
            size="sm"
            disabled={running || willMarkPaid === 0}
            onClick={() => setPaidOpen(true)}
          >
            Mark Paid
          </Button>
        )}
        {canWaive && (
          <Button
            variant="secondary"
            size="sm"
            disabled={running || willWaive === 0}
            onClick={() => setMode('waive')}
          >
            Waive
          </Button>
        )}
        {canMarkUnpaid && (
          <Button
            variant="secondary"
            size="sm"
            disabled={running || willMarkUnpaid === 0}
            onClick={() => setMode('unpaid')}
          >
            Mark Unpaid
          </Button>
        )}
        {busy && (
          <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-[var(--text-muted)]">
            {busy}
          </span>
        )}
      </SelectionBar>

      {/* Outside the bar — it is `sticky z-20` and therefore a stacking context,
          so a `fixed z-50` overlay nested inside it would sit under the console's
          own chrome. */}
      <Dialog open={paidOpen} onClose={() => setPaidOpen(false)} title="Mark fees paid">
        <div className="space-y-4">
          <p className="text-[var(--text-secondary)]">
            Records the {seasonName} fee as paid for everyone on this list.{' '}
            <strong className="text-[var(--text-primary)]">
              Each member is charged their own rate
            </strong>{' '}
            — the season’s competitive or recreational price, whichever applies to
            them. There is no amount to type here on purpose; to record a
            different figure for somebody, use Mark Paid on their own row.
          </p>
          <p className="text-sm text-[var(--text-muted)]">{scope(willMarkPaid, 'already paid or waived')}</p>
          <SelectionSummary noun="member" />
          {/* The shared method fields, unmodified — the one part of a payment
              that genuinely is the same for the whole queue. */}
          <PaymentMethodFields value={payment} onChange={setPayment} disabled={running} />
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setPaidOpen(false)} disabled={running}>
              Cancel
            </Button>
            <Button
              onClick={handleMarkPaid}
              disabled={running || paymentMethodInvalid(payment)}
            >
              {busy ?? `Mark ${willMarkPaid} paid`}
            </Button>
          </div>
        </div>
      </Dialog>

      <Dialog
        open={mode !== null}
        onClose={() => setMode(null)}
        title={mode === 'waive' ? 'Waive fees' : 'Mark fees unpaid'}
      >
        <div className="space-y-4">
          <p className="text-[var(--text-secondary)]">
            {mode === 'waive'
              ? `Writes off the ${seasonName} fee for everyone on this list — they drop out of the outstanding count. A member whose fee is already waived is left exactly as they are: re-waiving would replace the date it was waived and the officer who waived it.`
              : `Reverses the ${seasonName} fee for everyone on this list, whether it was paid or waived. The amount stays on the record; only the payment is cleared.`}
          </p>
          <p className="text-sm text-[var(--text-muted)]">
            {mode === 'waive'
              ? scope(willWaive, 'already paid or waived')
              : scope(willMarkUnpaid, 'already unpaid')}
          </p>
          <SelectionSummary noun="member" />
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setMode(null)} disabled={running}>
              Cancel
            </Button>
            <Button onClick={handleConfirm} disabled={running}>
              {busy ??
                (mode === 'waive' ? `Waive ${willWaive}` : `Mark ${willMarkUnpaid} unpaid`)}
            </Button>
          </div>
        </div>
      </Dialog>
    </>
  );
}
