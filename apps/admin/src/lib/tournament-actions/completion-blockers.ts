// THE REFUSAL COPY, SPLIT OUT SO IT CAN BE TESTED AT ALL.
//
// This lived in lib/actions/tournaments.ts, which carries 'use server'. Next
// permits only async function exports from such a file, so a pure helper there
// is unreachable from a test: it cannot be exported, and reaching it through
// the action means standing up the whole admin Supabase client. That is why the
// wrong-control bug below survived to production — nothing could assert on it.
//
// Everything here is pure and import-free of anything server-side.

import type { TournamentEventStatus, EventCompletionBucket } from '@badminton/shared';

export interface EventCompletionBlocker {
  id: string;
  label: string;
  status: TournamentEventStatus;
  statusLabel: string;
  bucket: EventCompletionBucket;
  incomplete: number;
  matchCount: number;
}

/**
 * The two controls that settle every unfinished event at once.
 *
 * THEY ARE DIFFERENT BUTTONS ON DIFFERENT SCREENS, and the refusal has to name
 * the one the exec is actually looking at. The tournament detail page completes
 * (tournament-status-controls.tsx, "Finalise Events & Complete"); the list's
 * overflow menu archives (tournaments/actions.tsx, "Finalise events &
 * archive"). One hardcoded string got this wrong for the archive path — the
 * exec was told to press "Finalise events & complete" on a screen whose only
 * such control says "& archive", which reads as a missing feature rather than
 * as the next step. Observed on staging 2026-08-18.
 */
export const REMEDY_COMPLETE = 'Finalise events & complete';
export const REMEDY_ARCHIVE = 'Finalise events & archive';

/**
 * The refusal the exec reads.
 *
 * It names every event rather than counting them, because the next thing they
 * will do is go and finish one, and "3 events are unfinished" does not say
 * which. The unplayed-match count is included where there is one, since that is
 * the number that decides whether finishing it by hand is five minutes' work or
 * an abandoned draw.
 */
export function describeCompletionBlockers(
  blockers: EventCompletionBlocker[],
  /** The control on the caller's own screen — see REMEDY_COMPLETE. */
  remedy: string,
): string {
  const parts = blockers.map((b) => {
    const detail = b.incomplete > 0 ? `${b.statusLabel}, ${b.incomplete} unplayed` : b.statusLabel;
    return `${b.label} (${detail})`;
  });
  const noun = blockers.length === 1 ? 'event has' : 'events have';
  return `${blockers.length} ${noun} not finished — ${parts.join('; ')}. `
    + `Finish them individually, or use "${remedy}" to settle them all now.`;
}
