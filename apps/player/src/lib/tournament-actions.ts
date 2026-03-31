'use server';

import { createServiceRoleClient, getCurrentPlayer } from './supabase-server';
import { revalidatePath } from 'next/cache';
import { isDoublesEvent } from '@badminton/shared';

async function requirePlayer() {
  const player = await getCurrentPlayer();
  if (!player) throw new Error('Not authenticated');
  if (player.status === 'pending_approval') throw new Error('Account pending approval');
  if (player.status === 'suspended') throw new Error('Account suspended');
  return player;
}

export async function registerForEvent(eventId: string) {
  const player = await requirePlayer();
  const service = createServiceRoleClient();

  const { data: event } = await service.from('tournament_events').select('*').eq('id', eventId).single();
  if (!event) throw new Error('Event not found');
  if (event.status !== 'registration') throw new Error('Registration is closed');

  const doubles = isDoublesEvent(event.event_type);
  if (doubles) throw new Error('Use pair registration for doubles events');

  const { data: existing } = await service.from('tournament_participants')
    .select('id').eq('event_id', eventId).eq('player_id', player.id).single();
  if (existing) throw new Error('Already registered');

  if (event.max_participants) {
    const { count } = await service.from('tournament_participants')
      .select('*', { count: 'exact', head: true })
      .eq('event_id', eventId)
      .not('status', 'in', '("withdrawn","disqualified")');
    if (count && count >= event.max_participants) throw new Error('Event is full');
  }

  const { data: rating } = await service.from('ratings').select('singles_elo').eq('player_id', player.id).single();

  await service.from('tournament_participants').insert({
    event_id: eventId,
    player_id: player.id,
    elo_before: rating?.singles_elo ?? 1200,
    status: 'registered',
  });

  revalidatePath('/tournaments');
}

export async function withdrawFromEvent(eventId: string) {
  const player = await requirePlayer();
  const service = createServiceRoleClient();

  const { data: participant } = await service.from('tournament_participants')
    .select('id, status').eq('event_id', eventId).eq('player_id', player.id).single();
  if (!participant) throw new Error('Not registered');
  if (participant.status !== 'registered' && participant.status !== 'checked_in') {
    throw new Error('Cannot withdraw at this stage');
  }

  await service.from('tournament_participants')
    .update({ status: 'withdrawn' })
    .eq('id', participant.id);

  revalidatePath('/tournaments');
}

export async function selfCheckIn(eventId: string) {
  const player = await requirePlayer();
  const service = createServiceRoleClient();

  const { data: event } = await service.from('tournament_events').select('status').eq('id', eventId).single();
  if (!event || event.status !== 'checkin') throw new Error('Check-in is not open');

  const { data: participant } = await service.from('tournament_participants')
    .select('id, status').eq('event_id', eventId).eq('player_id', player.id).single();
  if (!participant) throw new Error('Not registered');
  if (participant.status !== 'registered') throw new Error('Cannot check in');

  await service.from('tournament_participants')
    .update({ status: 'checked_in', checked_in_at: new Date().toISOString() })
    .eq('id', participant.id);

  revalidatePath('/tournaments');
}
