'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Button, Dialog, Textarea, useConfirm } from '@badminton/ui';
import { useToast } from '@/components/toast-provider';
import {
  confirmFeeSubmission,
  rejectFeeSubmission,
  remindUnpaidMembers,
} from '@/lib/actions/fee-submissions';

// The controls on an e-transfer receipt (00248): look at the screenshot,
// confirm it (the fee is marked paid by e-transfer with the member's
// reference), or reject it with a reason the member is shown.

export function SubmissionActions({
  submissionId,
  memberName,
  line,
  amount,
  reference,
  proofHref,
}: {
  submissionId: string;
  memberName: string;
  line: string;
  amount: string;
  reference: string;
  /** Null when the screenshot was removed with a purged account. */
  proofHref: string | null;
}) {
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState('');
  const [isPending, startTransition] = useTransition();
  const { toast } = useToast();
  const router = useRouter();
  const confirm = useConfirm();

  async function handleConfirm() {
    const ok = await confirm({
      title: 'Confirm this payment?',
      message: `${memberName}'s ${line} (${amount}) is marked paid by e-transfer, reference ${reference}. Check it arrived in the club's account first.`,
      confirmLabel: 'Confirm payment',
    });
    if (!ok) return;
    startTransition(async () => {
      const result = await confirmFeeSubmission(submissionId);
      if (!result.ok) {
        toast(result.error, 'error');
        return;
      }
      toast('Payment confirmed', 'success');
      router.refresh();
    });
  }

  function handleReject() {
    startTransition(async () => {
      const result = await rejectFeeSubmission(submissionId, reason);
      if (!result.ok) {
        toast(result.error, 'error');
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
            placeholder="e.g. No e-transfer with this reference reached the club account"
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
        'They get an in-app notification asking them to pay by e-transfer and upload the receipt. Nobody is reminded twice within 3 days.',
      confirmLabel: 'Send reminder',
    });
    if (!ok) return;
    startTransition(async () => {
      const result = await remindUnpaidMembers(playerIds);
      if (!result.ok) {
        toast(result.error, 'error');
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
