'use server';

import * as Sentry from '@sentry/nextjs';
import { revalidatePath } from 'next/cache';
import { createServiceRoleClient } from '../supabase-server';
import {
  eventFeedbackSchema,
  parseOrThrow,
  hasTournamentEnded,
  ExpectedError,
  type EventFeedbackInput,
} from '@badminton/shared';
import { requirePlayer, runAction, type ActionResult } from './_shared';

// Submit (or revise) feedback on a tournament. Stored with the player's id so
// the exec team can moderate and follow up — the UI tells members it's private
// to the exec team, never shown to other players.
//
// IT ALSO LEAVES THE APP. Since 00173 a response with a comment is relayed into
// the execs' Discord channel, named, and an edit here edits that message. The
// form copy says so. THE AUDIENCE IS STILL EXEC-ONLY and has to stay that way:
// the relay's target is event_feedback_channel_id, a setting deliberately kept
// separate from the bug-report channel so nobody widens this one by accident.
// If that key is ever pointed at a members-visible channel, this promise breaks
// and the copy above becomes false.
export async function submitEventFeedback(input: EventFeedbackInput): Promise<ActionResult> {
  return runAction(() => submitEventFeedbackImpl(input));
}

async function submitEventFeedbackImpl(input: EventFeedbackInput) {
  parseOrThrow(eventFeedbackSchema, input);
  const player = await requirePlayer();
  const supabase = createServiceRoleClient();

  // The page hides the form until the event is over; this enforces it. Hiding a
  // control is a UI convenience, not a rule — the action is directly callable,
  // and without this a stale page left open before the event would still post.
  const { data: tournament } = await supabase
    .from('tournaments')
    .select('status, start_date, end_date')
    .eq('id', input.tournament_id)
    .maybeSingle();

  if (!hasTournamentEnded(tournament)) {
    // ExpectedError: a closed feedback window is a normal state, not a fault,
    // so it surfaces as a message instead of being filed in Sentry.
    throw new ExpectedError('Feedback opens once the event has finished.');
  }

  const { error } = await supabase.from('event_feedback').upsert(
    {
      tournament_id: input.tournament_id,
      player_id: player.id,
      rating: input.rating ?? null,
      comment: input.comment ?? null,
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'tournament_id,player_id' },
  );
  if (error) {
    Sentry.captureException(error, { extra: { action: 'submitEventFeedback', tournamentId: input.tournament_id } });
    throw new Error(error.message);
  }

  revalidatePath(`/tournaments/${input.tournament_id}`);
}
