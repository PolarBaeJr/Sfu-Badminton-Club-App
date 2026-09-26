'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { ETRANSFER_REFERENCE_PATTERN, formatPaymentMethod, type ReceiptMethod } from '@badminton/shared';
import { Button, Dialog, Textarea, useConfirm } from '@badminton/ui';
import { useToast } from '@/components/toast-provider';
import {
  confirmFeeSubmission,
  rejectFeeSubmission,
  remindUnpaidMembers,
} from '@/lib/actions/fee-submissions';

// The controls on a payment receipt (00248, 00253): look at the screenshot,
// confirm it (the fee is marked paid by the method the receipt was read as,
// with the member's reference), or reject it with a reason the member is shown.
// When the member's browser could not tell how it was paid, confirming asks.

export function SubmissionActions({
  submissionId,
  memberName,
  line,
  amount,
  reference,
  proofHref,
  method,
  feeType,
}: {
  submissionId: string;
  memberName: string;
  line: string;
  amount: string;
  reference: string;
  /** Null when the screenshot was removed with a purged account. */
  proofHref: string | null;
  /** Null when the member's browser could not tell; the exec picks. */
  method: ReceiptMethod | null;
  feeType: string;
}) {
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState('');
  const [choosing, setChoosing] = useState(false);
  const [chosen, setChosen] = useState<ReceiptMethod | null>(null);
  const [isPending, startTransition] = useTransition();
  const { toast } = useToast();
  const router = useRouter();
  const confirm = useConfirm();

  // Only dues are sold on the SFU Rec website.
  const choices: ReceiptMethod[] = feeType === 'dues' ? ['e_transfer', 'sfu_rec'] : ['e_transfer'];
  // A 4 or 5 character number cannot be an e-transfer reference (00253).
  const shortReference = !ETRANSFER_REFERENCE_PATTERN.test(reference);

  function send(picked?: ReceiptMethod) {
    startTransition(async () => {
      const result = await confirmFeeSubmission(submissionId, picked);
      if (!result.ok) {
        toast(result.code ? `${result.error} (${result.code}.${result.ref})` : result.error, 'error');
        return;
      }
      toast('Payment confirmed', 'success');
      setChoosing(false);
      setChosen(null);
      router.refresh();
    });
  }

  async function handleConfirm() {
    if (!method) {
      setChoosing(true);
      return;
    }
    const ok = await confirm({
      title: 'Confirm this payment?',
      message: `${memberName}'s ${line} (${amount}) is marked paid by ${formatPaymentMethod(method)}, reference ${reference}. Check it arrived first.`,
      confirmLabel: 'Confirm payment',
    });
    if (!ok) return;
    send();
  }

  function handleReject() {
    startTransition(async () => {
      const result = await rejectFeeSubmission(submissionId, reason);
      if (!result.ok) {
        toast(result.code ? `${result.error} (${result.code}.${result.ref})` : result.error, 'error');
        return;
      }
      toast('Receipt rejected', 'success');
      setRejecting(false);
      setReason('');
      router.refresh();
    });
  }

  return (
    <>
      {proofHref ? (
        <a
          href={proofHref}
          target="_blank"
          rel="noopener noreferrer"
          className="text-sm text-[var(--color-accent)] font-medium px-2"
        >
          View screenshot
        </a>
      ) : (
        <span className="text-xs text-[var(--text-muted)] px-2">No screenshot</span>
      )}
      <Button variant="ghost" size="sm" onClick={handleConfirm} loading={isPending}>
        Confirm
      </Button>
      <Button variant="ghost" size="sm" onClick={() => setRejecting(true)} disabled={isPending}>
        Reject
      </Button>
      <Dialog open={rejecting} onClose={() => setRejecting(false)} title={`Reject receipt: ${memberName}`}>
        <div className="space-y-4">
          <p className="text-sm text-[var(--text-secondary)]">
            {memberName} is sent a notification with this reason and can send a new receipt.
          </p>
          <Textarea
            label="Reason"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="e.g. No payment with this reference reached the club"
            maxLength={500}
            rows={3}
          />
          <div className="flex gap-2">
            <Button variant="ghost" onClick={() => setRejecting(false)}>
              Cancel
            </Button>
            <Button
              onClick={handleReject}
              loading={isPending}
              disabled={reason.trim().length < 3}
              className="flex-1"
            >
              Reject receipt
            </Button>
          </div>
        </div>
      </Dialog>
      <Dialog open={choosing} onClose={() => setChoosing(false)} title={`Confirm payment: ${memberName}`}>
        <div className="space-y-4">
          <p className="text-sm text-[var(--text-secondary)]">
            The site could not tell how {memberName} paid their {line} ({amount}), reference {reference}.
            Check the screenshot, say how it was paid, and check it arrived first.
          </p>
          <div className="flex gap-2">
            {choices.map((m) => (
              <Button
                key={m}
                variant={chosen === m ? 'primary' : 'ghost'}
                size="sm"
                aria-pressed={chosen === m}
                onClick={() => setChosen(m)}
                disabled={isPending || (m === 'e_transfer' && shortReference)}
              >
                {m === 'e_transfer' ? 'Interac e-Transfer' : 'SFU Rec website'}
              </Button>
            ))}
          </div>
          {shortReference && (
            <p className="text-xs text-[var(--text-muted)]">
              {reference} is too short for an e-transfer reference, so this can only be an SFU Rec receipt.
              If it is not one, reject it and ask for the right reference.
            </p>
          )}
          <div className="flex gap-2">
            <Button variant="ghost" onClick={() => setChoosing(false)}>
              Cancel
            </Button>
            <Button
              onClick={() => chosen && send(chosen)}
              loading={isPending}
              disabled={!chosen}
              className="flex-1"
            >
              Confirm payment
            </Button>
          </div>
        </div>
      </Dialog>
    </>
  );
}

/**
 * "Remind unpaid" over the whole list, or "Remind" on one row. The count in
 * the dialog is who the page thinks is due one; the action decides again.
 */
export function RemindButton({
  playerIds,
  label,
  noun,
}: {
  playerIds: string[];
  label: string;
  /** "Ana Lee", or "14 members". */
  noun: string;
}) {
  const [isPending, startTransition] = useTransition();
  const { toast } = useToast();
  const router = useRouter();
  const confirm = useConfirm();

  async function handleRemind() {
    const ok = await confirm({
      title: `Send a reminder to ${noun}?`,
      message:
        'They get an in-app notification asking them to pay and upload the receipt. Nobody is reminded twice within 3 days.',
      confirmLabel: 'Send reminder',
    });
    if (!ok) return;
    startTransition(async () => {
      const result = await remindUnpaidMembers(playerIds);
      if (!result.ok) {
        toast(result.code ? `${result.error} (${result.code}.${result.ref})` : result.error, 'error');
        return;
      }
      const { sent, skipped } = result.data;
      toast(
        skipped > 0
          ? `Reminded ${sent}. ${skipped} skipped: paid, sent a receipt, or reminded recently.`
          : `Reminded ${sent} ${sent === 1 ? 'member' : 'members'}`,
        'success',
      );
      router.refresh();
    });
  }

  return (
    <Button variant="ghost" size="sm" onClick={handleRemind} loading={isPending} disabled={playerIds.length === 0}>
      {label}
    </Button>
  );
}
