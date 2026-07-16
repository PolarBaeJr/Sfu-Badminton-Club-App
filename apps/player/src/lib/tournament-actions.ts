'use server';

import { createServiceRoleClient } from './supabase-server';
import { revalidatePath } from 'next/cache';
import { isDoublesEvent } from '@badminton/shared';
import { requirePlayer } from './actions/_shared';

// Revalidate every surface that surfaces tournament_participants /
// tournament_pairs after a register/withdraw/check-in. The event detail
// page must be in this list — that's the page where the user clicked
// the action button, and "No participants yet" was rendering stale.
function revalidateTournamentPaths(tournamentId: string, eventId: string) {
  revalidatePath('/tournaments');
  revalidatePath(`/tournaments/${tournamentId}`);
  revalidatePath(`/tournaments/${tournamentId}/events/${eventId}`);
}

export async function registerForEvent(eventId: string) {
  const player = await requirePlayer();
  const service = createServiceRoleClient();

  // Parallelize the three independent reads needed before we can validate.
  // `.maybeSingle()` instead of `.single()` so a missing existing row isn't
  // surfaced as a thrown PGRST116 error.
  const [eventRes, existingRes, ratingRes] = await Promise.all([
    service.from('tournament_events')
      .select('id, status, event_type, tournament_id, max_participants')
      .eq('id', eventId).maybeSingle(),
    service.from('tournament_participants')
      .select('id').eq('event_id', eventId).eq('player_id', player.id).maybeSingle(),
    service.from('ratings').select('singles_elo').eq('player_id', player.id).maybeSingle(),
  ]);

  const event = eventRes.data;
  if (!event) throw new Error('Event not found');
  if (event.status !== 'registration') throw new Error('Registration is closed');
  if (isDoublesEvent(event.event_type)) throw new Error('Use pair registration for doubles events');
  if (existingRes.data) throw new Error('Already registered');

  // Capacity check is the only thing that has to wait — it depends on a fresh count.
  if (event.max_participants) {
    const { count } = await service.from('tournament_participants')
      .select('id', { count: 'exact', head: true })
      .eq('event_id', eventId)
      .not('status', 'in', '("withdrawn","disqualified")');
    if (count && count >= event.max_participants) throw new Error('Event is full');
  }

  const { error: insertErr } = await service.from('tournament_participants').insert({
    event_id: eventId,
    player_id: player.id,
    elo_before: ratingRes.data?.singles_elo ?? 1200,
    status: 'registered',
  });
  if (insertErr) throw new Error(insertErr.message);

  revalidateTournamentPaths(event.tournament_id, eventId);
}

export async function withdrawFromEvent(eventId: string) {
  const player = await requirePlayer();
  const service = createServiceRoleClient();

  const { data: participant } = await service.from('tournament_participants')
    .select('id, status, event:tournament_events(tournament_id)')
    .eq('event_id', eventId).eq('player_id', player.id).maybeSingle();
  if (!participant) throw new Error('Not registered');
  if (participant.status !== 'registered' && participant.status !== 'checked_in') {
    throw new Error('Cannot withdraw at this stage');
  }

  const { error } = await service.from('tournament_participants')
    .update({ status: 'withdrawn' })
    .eq('id', participant.id);
  if (error) throw new Error(error.message);

  const tid = (participant.event as unknown as { tournament_id: string } | null)?.tournament_id;
  if (tid) revalidateTournamentPaths(tid, eventId);
  else revalidatePath('/tournaments');
}

export async function selfCheckIn(eventId: string) {
  const player = await requirePlayer();
  const service = createServiceRoleClient();

  // Parallel reads — event status and player participation row are independent.
  const [eventRes, participantRes] = await Promise.all([
    service.from('tournament_events')
      .select('status, tournament_id').eq('id', eventId).maybeSingle(),
    service.from('tournament_participants')
      .select('id, status').eq('event_id', eventId).eq('player_id', player.id).maybeSingle(),
  ]);

  const event = eventRes.data;
  const participant = participantRes.data;
  if (!event || event.status !== 'checkin') throw new Error('Check-in is not open');
  if (!participant) throw new Error('Not registered');
  if (participant.status !== 'registered') throw new Error('Cannot check in');

  const { error } = await service.from('tournament_participants')
    .update({ status: 'checked_in', checked_in_at: new Date().toISOString() })
    .eq('id', participant.id);
  if (error) throw new Error(error.message);

  revalidateTournamentPaths(event.tournament_id, eventId);
}
