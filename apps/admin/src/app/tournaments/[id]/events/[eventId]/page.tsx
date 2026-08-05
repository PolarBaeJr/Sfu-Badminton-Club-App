import { createAdminClient } from '@/lib/supabase-server';
import { notFound } from 'next/navigation';
import { TOURNAMENT_EVENT_TYPE_LABELS, isDoublesEvent } from '@badminton/shared';
import { ArrowLeft } from 'lucide-react';
import Link from 'next/link';
import { EventControlCenter } from './components/EventControlCenter';
import type { ParticipantWithPlayer, PairWithPlayers } from '@/lib/tournament-types';

export default async function EventPage({
  params,
}: {
  params: Promise<{ id: string; eventId: string }>;
}) {
  const { id: tournamentId, eventId } = await params;
  const supabase = createAdminClient();

  const { data: tournament } = await supabase.from('tournaments').select('*').eq('id', tournamentId).single();
  if (!tournament) notFound();

  const { data: event } = await supabase.from('tournament_events').select('*').eq('id', eventId).single();
  if (!event) notFound();

  const doubles = isDoublesEvent(event.event_type);

  // Fetch participants or pairs
  let participants: ParticipantWithPlayer[] = [];
  let pairs: PairWithPlayers[] = [];

  if (doubles) {
    const { data } = await supabase
      .from('tournament_pairs')
      .select('*, player1:players!tournament_pairs_player1_id_fkey(id, full_name, avatar_url), player2:players!tournament_pairs_player2_id_fkey(id, full_name, avatar_url)')
      .eq('event_id', eventId)
      .order('seed_number', { ascending: true, nullsFirst: false });
    pairs = data ?? [];
  } else {
    const { data } = await supabase
      .from('tournament_participants')
      .select('*, player:players!player_id(id, full_name, avatar_url, ratings(singles_elo, doubles_elo, singles_provisional, doubles_provisional, singles_matches_played, doubles_matches_played))')
      .eq('event_id', eventId)
      .order('seed_number', { ascending: true, nullsFirst: false });
    participants = data ?? [];
  }

  // Fetch matches
  const { data: matches } = await supabase
    .from('tournament_matches')
    .select('*')
    .eq('event_id', eventId)
    .order('round_number')
    .order('bracket_position');

  // Fetch all eligible players for participant add (includes admins)
  const { data: allPlayers } = await supabase
    .from('players')
    .select('id, full_name, avatar_url')
    .not('status', 'in', '("suspended","pending_approval")')
    .order('full_name');

  return (
    <div className="space-y-6">
      <Link
        href={`/tournaments/${tournamentId}`}
        className="inline-flex items-center gap-1.5 text-sm text-[var(--text-muted)] hover:text-[var(--color-accent)] transition-colors"
      >
        <ArrowLeft className="w-4 h-4" />
        Back to {tournament.name}
      </Link>

      <EventControlCenter
        tournament={tournament}
        event={event}
        participants={participants}
        pairs={pairs}
        matches={matches ?? []}
        allPlayers={allPlayers ?? []}
        isDoubles={doubles}
      />
    </div>
  );
}
