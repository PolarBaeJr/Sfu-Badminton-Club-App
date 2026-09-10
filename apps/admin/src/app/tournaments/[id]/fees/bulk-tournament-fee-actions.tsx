'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button, Dialog } from '@badminton/ui';
import { resolvePaymentMethod } from '@badminton/shared';
import { useToast } from '@/components/toast-provider';
import { SelectionBar, SelectionSummary, useSelection } from '@/components/selection';
import { describeBulkOutcome, useBulkRun } from '@/components/use-bulk-run';
import { bulkMarkTournamentFeesPaid, bulkMarkTournamentFeesUnpaid } from '@/lib/actions';
import { countEligible, type FeeRowState } from '@/lib/fee-bulk-eligibility';
import {
  PaymentMethodFields,
  paymentMethodInvalid,
  EMPTY_PAYMENT_METHOD,
  type PaymentMethodState,
} from '@/app/fees/payment-method-fields';

/**
 * The entry-fee desk, for several entrants at once.
 *
 * THE CASE THIS EXISTS FOR is the registration table on the morning of an event:
 * a queue of entrants paying cash, and one dialog per person.
 *
 * NEITHER AN AMOUNT NOR A TIER, and this is the design point rather than an
 * omission. bulkMarkTournamentFeesPaid sends neither, so markTournamentFeePaid
 * keeps the price already on each entrant's row — the one ensureEntryFees seeded
 * from their real membership tier. One shared tier across a thirty-person
 * selection is exactly the overwrite e6f71300 closed on the single-record path:
 * a $15 internal member recorded as having paid the $25 external default,
 * silently, with the audit entry agreeing. Recording a different figure for one
 * person is that person's own row dialog.
 *
 * THE ONE ENTRANT THAT IS NOT TRUE OF, known and left as it is: somebody entered
 * with no club_fees row (or a row carrying no price) has no snapshot to keep, so
 * markTournamentFeePaid prices them from the tournament's is_default tier — not
 * from their membership, which is what their own row's dialog would prefill. The
 * paragraph in the Mark Paid dialog below therefore overstates it for that one
 * case. actions/bulk.ts says why fixing it would cost more than it buys, and a
 * test in lib/__tests__/bulk-actions.test.ts pins the behaviour.
 *
 * NO BULK WAIVE, matching the page: the entry-fee desk has never had a Waive
 * control of its own. "Unwaive" here is Mark Unpaid, which is the same action.
 *
 * `states` says how many of the selection each dialog will really touch and is
 * used for nothing else — see lib/fee-bulk-eligibility. Every selected id is
 * sent, and the server refuses the rest per record, by name.
 */
export function BulkTournamentFeeActions({
  tournamentId,
  states,
  canMarkPaid,
  canMarkUnpaid,
}: {
  tournamentId: string;
  /** Each selectable row's current state, keyed by PLAYER id. A snapshot. */
  states: Record<string, FeeRowState>;
  canMarkPaid: boolean;
  canMarkUnpaid: boolean;
}) {
  const router = useRouter();
  const { toast } = useToast();
  const { selectedItems, clear } = useSelection();
  const { running, progress, run } = useBulkRun();

  const [paidOpen, setPaidOpen] = useState(false);
  const [payment, setPayment] = useState<PaymentMethodState>(EMPTY_PAYMENT_METHOD);
  const [unpaidOpen, setUnpaidOpen] = useState(false);

  if (!canMarkPaid && !canMarkUnpaid) return null;

  const ids = selectedItems.map((i) => i.id);
  const nameOf = (id: string) => selectedItems.find((i) => i.id === id)?.label ?? id;
  const busy = running ? `${progress?.done ?? 0} of ${progress?.total ?? ids.length}…` : null;

  const willMarkPaid = countEligible(ids, states, 'markPaid');
  const willMarkUnpaid = countEligible(ids, states, 'markUnpaid');

  const scope = (eligible: number, whatTheRestAre: string) =>
    eligible === ids.length
      ? `All ${ids.length} selected.`
      : `${eligible} of the ${ids.length} selected. The other ${ids.length - eligible} ${
          ids.length - eligible === 1 ? 'is' : 'are'
        } ${whatTheRestAre}, and will be refused by name rather than changed.`;

  async function handleMarkPaid() {
    const result = await run(ids, (chunk) =>
      bulkMarkTournamentFeesPaid(
        chunk,
        tournamentId,
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

  async function handleMarkUnpaid() {
    const result = await run(ids, (chunk) => bulkMarkTournamentFeesUnpaid(chunk, tournamentId));
    setUnpaidOpen(false);
    router.refresh();
    if (!result.ok) {
      toast(result.error ?? 'Something went wrong', 'error');
    } else {
      const { message, type } = describeBulkOutcome(result.outcome, 'marked unpaid', nameOf);
      toast(message, type);
    }
    clear();
  }

  return (
    <>
      <SelectionBar noun="entrant">
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
        {canMarkUnpaid && (
          <Button
            variant="secondary"
            size="sm"
            disabled={running || willMarkUnpaid === 0}
            onClick={() => setUnpaidOpen(true)}
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
      <Dialog open={paidOpen} onClose={() => setPaidOpen(false)} title="Mark entry fees paid">
        <div className="space-y-4">
          <p className="text-[var(--text-secondary)]">
            Records the entry fee as paid for everyone on this list.{' '}
            <strong className="text-[var(--text-primary)]">
              Each entrant is charged their own rate
            </strong>{' '}
            — the price already on their entry, from the tier their membership put
            them in. There is no amount or tier to pick here on purpose; to record
            a different figure for somebody, use Mark Paid on their own row.
          </p>
          <p className="text-sm text-[var(--text-muted)]">{scope(willMarkPaid, 'already paid or waived')}</p>
          <SelectionSummary noun="entrant" />
          <PaymentMethodFields value={payment} onChange={setPayment} disabled={running} />
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setPaidOpen(false)} disabled={running}>
              Cancel
            </Button>
            <Button onClick={handleMarkPaid} disabled={running || paymentMethodInvalid(payment)}>
              {busy ?? `Mark ${willMarkPaid} paid`}
            </Button>
          </div>
        </div>
      </Dialog>

      <Dialog open={unpaidOpen} onClose={() => setUnpaidOpen(false)} title="Mark entry fees unpaid">
        <div className="space-y-4">
          <p className="text-[var(--text-secondary)]">
            Reverses the entry fee for everyone on this list, whether it was paid
            or waived. The entry itself stays on the books and so does its price —
            only the payment is cleared.
          </p>
          <p className="text-sm text-[var(--text-muted)]">{scope(willMarkUnpaid, 'already unpaid')}</p>
          <SelectionSummary noun="entrant" />
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setUnpaidOpen(false)} disabled={running}>
              Cancel
            </Button>
            <Button onClick={handleMarkUnpaid} disabled={running}>
              {busy ?? `Mark ${willMarkUnpaid} unpaid`}
            </Button>
          </div>
        </div>
      </Dialog>
    </>
  );
}
