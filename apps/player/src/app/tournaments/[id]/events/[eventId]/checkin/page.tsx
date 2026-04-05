import { createServerSupabaseClient, getCurrentPlayer } from '@/lib/supabase-server';
import { notFound, redirect } from 'next/navigation';
import { SelfCheckInClient } from './SelfCheckInClient';

export default async function CheckInPage({
  params,
}: {
  params: Promise<{ id: string; eventId: string }>;
}) {
  const { id: tournamentId, eventId } = await params;
  const supabase = await createServerSupabaseClient();

  const { data: event, error: eventError } = await supabase
    .from('tournament_events')
    .select('status')
    .eq('id', eventId)
    .single();
  if (eventError || !event) notFound();

  const player = await getCurrentPlayer();
  if (!player) redirect('/login');

  const { data: registration } = await supabase
    .from('tournament_participants')
    .select('id, status')
    .eq('event_id', eventId)
    .eq('player_id', player.id)
    .maybeSingle();

  return (
    <SelfCheckInClient
      eventId={eventId}
      tournamentId={tournamentId}
      eventStatus={event.status}
      registration={registration ? { id: registration.id, status: registration.status } : null}
      playerName={player.full_name}
    />
  );
}
