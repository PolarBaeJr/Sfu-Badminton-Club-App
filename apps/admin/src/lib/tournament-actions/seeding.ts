'use server';

import * as Sentry from '@sentry/nextjs';
import { createAdminClient } from '../supabase-server';
import { logAudit } from '../audit';
import { isDoublesEvent } from '@badminton/shared';
import { getExecOrAdmin, revalidateEventPaths } from './_internal';

export async function updateParticipantSeed(participantId: string, seedNumber: number | null) {
  await getExecOrAdmin('tournaments');
  const adminClient = createAdminClient();

  const { data: participant } = await adminClient.from('tournament_participants')
    .select('event_id, event:tournament_events(tournament_id, draw_locked)')
    .eq('id', participantId)
    .single();
  const ev = (participant?.event as unknown as { tournament_id: string; draw_locked: boolean } | null);
  if (ev?.draw_locked) throw new Error('Draw is locked. Unlock it before changing seeds.');

  const { error } = await adminClient.from('tournament_participants')
    .update({ seed_number: seedNumber })
    .eq('id', participantId);

  if (error) {
    Sentry.captureException(error);
    throw new Error(error.message);
  }

  if (ev?.tournament_id && participant?.event_id) {
    revalidateEventPaths(ev.tournament_id, participant.event_id as string);
  }
}

export async function updatePairSeed(pairId: string, seedNumber: number | null) {
  await getExecOrAdmin('tournaments');
  const adminClient = createAdminClient();

  const { data: pair } = await adminClient.from('tournament_pairs')
    .select('event_id, event:tournament_events(tournament_id, draw_locked)')
    .eq('id', pairId)
    .single();
  const ev = (pair?.event as unknown as { tournament_id: string; draw_locked: boolean } | null);
  if (ev?.draw_locked) throw new Error('Draw is locked. Unlock it before changing seeds.');

  const { error } = await adminClient.from('tournament_pairs')
    .update({ seed_number: seedNumber })
    .eq('id', pairId);

  if (error) {
    Sentry.captureException(error);
    throw new Error(error.message);
  }

  if (ev?.tournament_id && pair?.event_id) {
    revalidateEventPaths(ev.tournament_id, pair.event_id as string);
  }
}

export async function autoSeedEventByElo(eventId: string) {
  const admin = await getExecOrAdmin('tournaments');
  const adminClient = createAdminClient();

  const { data: event } = await adminClient.from('tournament_events').select('*').eq('id', eventId).single();
  if (!event) throw new Error('Event not found');

  if (event.draw_locked) throw new Error('Draw is locked. Unlock it before making changes.');

  const doubles = isDoublesEvent(event.event_type);

  if (doubles) {
    const { data: pairs } = await adminClient.from('tournament_pairs')
      .select('id, combined_elo')
      .eq('event_id', eventId)
      .not('status', 'in', '("withdrawn","disqualified")')
      .order('combined_elo', { ascending: false, nullsFirst: false });

    if (pairs) {
      for (let i = 0; i < pairs.length; i++) {
        await adminClient.from('tournament_pairs')
          .update({ seed_number: i + 1 })
          .eq('id', pairs[i]!.id);
      }
    }
  } else {
    const { data: participants } = await adminClient.from('tournament_participants')
      .select('id, elo_before')
      .eq('event_id', eventId)
      .not('status', 'in', '("withdrawn","disqualified")')
      .order('elo_before', { ascending: false, nullsFirst: false });

    if (participants) {
      for (let i = 0; i < participants.length; i++) {
        await adminClient.from('tournament_participants')
          .update({ seed_number: i + 1 })
          .eq('id', participants[i]!.id);
      }
    }
  }

  await logAudit(adminClient, {
    tournament_id: event.tournament_id,
    event_id: eventId,
    action: 'auto_seeded',
    performed_by: admin.id,
  });

  revalidateEventPaths(event.tournament_id, eventId);
}

// ============================================================
// Clear Seeds
// ============================================================

export async function clearSeeds(eventId: string) {
  const admin = await getExecOrAdmin('tournaments');
  const adminClient = createAdminClient();

  const { data: event } = await adminClient.from('tournament_events').select('*').eq('id', eventId).single();
  if (!event) throw new Error('Event not found');
  if (event.draw_locked) throw new Error('Draw is locked. Unlock it before clearing seeds.');

  const doubles = isDoublesEvent(event.event_type);
  const table = doubles ? 'tournament_pairs' : 'tournament_participants';

  const { error } = await adminClient.from(table)
    .update({ seed_number: null })
    .eq('event_id', eventId);

  if (error) {
    Sentry.captureException(error);
    throw new Error(error.message);
  }

  await logAudit(adminClient, {
    tournament_id: event.tournament_id,
    event_id: eventId,
    action: 'seeds_cleared',
    performed_by: admin.id,
  });

  revalidateEventPaths(event.tournament_id, eventId);
}
