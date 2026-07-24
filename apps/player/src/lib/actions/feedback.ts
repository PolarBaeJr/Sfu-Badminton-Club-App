'use server';

import * as Sentry from '@sentry/nextjs';
import { revalidatePath } from 'next/cache';
import { createServiceRoleClient } from '../supabase-server';
import { eventFeedbackSchema, parseOrThrow, type EventFeedbackInput } from '@badminton/shared';
import { requirePlayer, runAction, type ActionResult } from './_shared';

// Submit (or revise) feedback on a tournament. Stored with the player's id so
// the exec team can moderate and follow up — the UI tells members it's private
// to the exec team, never shown to other players.
export async function submitEventFeedback(input: EventFeedbackInput): Promise<ActionResult> {
  return runAction(() => submitEventFeedbackImpl(input));
}

async function submitEventFeedbackImpl(input: EventFeedbackInput) {
  parseOrThrow(eventFeedbackSchema, input);
  const player = await requirePlayer();
  const supabase = createServiceRoleClient();

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
