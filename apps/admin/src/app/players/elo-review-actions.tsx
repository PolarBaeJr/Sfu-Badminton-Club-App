'use client';

import { useState, useTransition } from 'react';
import { Button, Dialog } from '@badminton/ui';
import { useRouter } from 'next/navigation';
import { useToast } from '@/components/toast-provider';
import { type EloReview } from '@badminton/shared';
import { resolveEloReview } from '@/lib/actions';

// A SIBLING OF PrivilegeReviewActions, and built the same way for the same
// reason: one flag, one outcome, no form. The two are deliberately not merged —
// they are gated on different capabilities and say different things — but they
// render side by side on the roster, so they read as one kind of object.

export function EloReviewActions({
  playerId,
  playerName,
  review,
  canResolve,
}: {
  playerId: string;
  playerName: string;
  review: EloReview;
  /** players.merge.write. The server action is the real gate; this only keeps
   *  somebody from being offered a button guaranteed to refuse them. */
  canResolve: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [isPending, startTransition] = useTransition();
  const router = useRouter();
  const { toast } = useToast();

  if (!canResolve) return null;

  const selfPlay = review.selfPlayMatches.length + review.selfPlayTournamentMatches.length;
  const discardedRows = Object.values(review.discarded).reduce((a, b) => a + b, 0);

  const run = () =>
    startTransition(async () => {
      const result = await resolveEloReview(playerId);
      if (!result.ok) {
        toast(result.error, 'error');
        return;
      }
      toast('Review cleared.', 'success');
      setOpen(false);
      router.refresh();
    });

  return (
    <>
      <Button variant="ghost" onClick={() => setOpen(true)} disabled={isPending}>
        Reviewed
      </Button>

      <Dialog open={open} onClose={() => setOpen(false)} title="Clear this merge review">
        <div className="space-y-4">
          <p className="text-sm text-[var(--text-secondary)]">
            {review.mergedFromName ? (
              <>
                <strong>{review.mergedFromName}</strong> was merged into {playerName}
                {review.at ? ` on ${review.at.slice(0, 10)}` : ''}.
              </>
            ) : (
              <>A merge into {playerName} left something to look at.</>
            )}
          </p>

          {/* The counts, not the ids. An admin deciding whether they have
              finished looking needs to recognise the review, not re-read it;
              the ids are in the audit log and stay there after this clears. */}
          <ul className="space-y-1 text-sm text-[var(--text-secondary)]">
            {selfPlay > 0 && (
              <li>
                <span className="text-[var(--color-danger)]">
                  {selfPlay} {selfPlay === 1 ? 'match' : 'matches'} where the two accounts played
                  each other.
                </span>{' '}
                The rating movement from those was transferred, not earned. They are left in place
                on purpose — re-rating one match re-rates every result recorded after it.
              </li>
            )}
            {discardedRows > 0 && (
              <li>
                {discardedRows} {discardedRows === 1 ? 'row was' : 'rows were'} discarded because{' '}
                {playerName} already had one in the same scope
                {': '}
                {Object.entries(review.discarded)
                  .map(([table, n]) => `${table} (${n})`)
                  .join(', ')}
                .
              </li>
            )}
          </ul>

          <p className="text-sm text-[var(--text-secondary)]">
            Clearing this only says you have looked. Nothing about {playerName}&apos;s rating,
            record or access changes, and there will be no further prompt — the merge and this
            review stay readable in the audit log.
          </p>

          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setOpen(false)} disabled={isPending}>
              Cancel
            </Button>
            <Button variant="primary" onClick={run} disabled={isPending}>
              {isPending ? 'Saving…' : 'Clear'}
            </Button>
          </div>
        </div>
      </Dialog>
    </>
  );
}
