'use client';

import { useState, useTransition } from 'react';
import { Button, Dialog } from '@badminton/ui';
import { useRouter } from 'next/navigation';
import { useToast } from '@/components/toast-provider';
import { describePrivileges, type PrivilegeClaimReview } from '@badminton/shared';
import { resolvePrivilegeClaimReview } from '@/lib/actions';

// A COMPONENT OF ITS OWN rather than a seventh mode on PlayerActions. Every mode
// that component has is a variation on one dialog over the member's own fields;
// this is a decision about one flag with two outcomes and no form. Folding it in
// would have meant touching roster-actions.ts, its tests and the shared dialog to
// express something that fits in a confirm.

export function PrivilegeReviewActions({
  playerId,
  playerName,
  review,
  canResolve,
  isSelf,
}: {
  playerId: string;
  playerName: string;
  review: PrivilegeClaimReview;
  /** players.consoleaccess.write. The server action is the real gate; this only
   *  keeps somebody from being offered a button guaranteed to refuse them. */
  canResolve: boolean;
  /** This row is the viewer's own. resolvePrivilegeClaimReview refuses that
   *  before it reads anything — the same self-edit refusal setConsoleAccess
   *  makes, and for the same reason: restoring your own withheld privileges is
   *  the one move that would let this capability promote its holder. */
  isSelf: boolean;
}) {
  const [decision, setDecision] = useState<'restore' | 'dismiss' | null>(null);
  const [isPending, startTransition] = useTransition();
  const router = useRouter();
  const { toast } = useToast();

  if (!canResolve) return null;

  // SAID RATHER THAN SILENTLY DROPPED, which is how /permissions handles the
  // same case on its console-access control. Returning null here would leave a
  // review badge on your own row with nothing beside it and no explanation, and
  // "why can I not act on this" is a worse question than the answer.
  if (isSelf) {
    return (
      <p className="px-3 text-xs text-[var(--text-muted)] max-w-[42ch]">
        You cannot resolve your own review — restoring your own privileges is the one
        change that would let you promote yourself. Ask another admin.
      </p>
    );
  }

  const held = describePrivileges(review.withheld);
  const kept = describePrivileges(review.kept);
  const hasWithheld = Object.keys(review.withheld).length > 0;

  const run = (choice: 'restore' | 'dismiss') =>
    startTransition(async () => {
      const result = await resolvePrivilegeClaimReview(playerId, choice);
      if (!result.ok) {
        toast(result.error, 'error');
        return;
      }
      toast(
        choice === 'restore' ? `Restored ${held} for ${playerName}.` : 'Review cleared.',
        'success',
      );
      setDecision(null);
      router.refresh();
    });

  return (
    <>
      {/* Restore is offered only when something was actually withheld. A review
          that KEPT everything has nothing to restore — the only thing left to do
          with it is acknowledge it, and offering a Restore that would write an
          empty update is a button that lies about what it does. */}
      {hasWithheld && (
        <Button variant="ghost" onClick={() => setDecision('restore')} disabled={isPending}>
          Restore
        </Button>
      )}
      <Button variant="ghost" onClick={() => setDecision('dismiss')} disabled={isPending}>
        {hasWithheld ? 'Dismiss' : 'Acknowledge'}
      </Button>

      <Dialog
        open={decision !== null}
        onClose={() => setDecision(null)}
        title={decision === 'restore' ? 'Restore console privileges' : 'Clear this review'}
      >
        <div className="space-y-4">
          <p className="text-sm text-[var(--text-secondary)]">
            {decision === 'restore' ? (
              <>
                {playerName} will get <strong>{held}</strong> back. This is the privilege their
                pre-added roster row was carrying when they signed in and claimed it; it was held
                because nothing in the audit log shows an exec granting it deliberately.
              </>
            ) : hasWithheld ? (
              <>
                The review disappears and {playerName} stays an ordinary member.{' '}
                <strong>{held}</strong> is not restored, and there will be no further prompt — grant
                it from Permissions if you change your mind.
              </>
            ) : (
              <>
                {playerName} keeps <strong>{kept}</strong>. Clearing this only says you have seen it;
                nothing about their access changes.
              </>
            )}
          </p>
          {review.backfilled && (
            <p className="text-sm text-[var(--color-warning)]">
              Reconstructed from the older audit record of this claim, so the date shown is when the
              privilege was taken, not when this review was written.
            </p>
          )}
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setDecision(null)} disabled={isPending}>
              Cancel
            </Button>
            <Button
              variant={decision === 'restore' ? 'primary' : 'ghost'}
              onClick={() => decision && run(decision)}
              disabled={isPending}
            >
              {isPending ? 'Saving…' : decision === 'restore' ? 'Restore' : 'Clear'}
            </Button>
          </div>
        </div>
      </Dialog>
    </>
  );
}
