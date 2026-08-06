import { createAdminClient } from '@/lib/supabase-server';
import { notFound } from 'next/navigation';
import { TOURNAMENT_EVENT_TYPE_LABELS, isDoublesEvent } from '@badminton/shared';
import { ArrowLeft } from 'lucide-react';
import Link from 'next/link';
import { EventControlCenter } from './components/EventControlCenter';
import { getTournamentBonusSettings } from '@/lib/platform-settings';
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

  // Other events in the same tournament — the candidates this one can be
  // seeded from. Excludes itself: the schema forbids a self-seed outright.
  const { data: siblingEvents } = await supabase
    .from('tournament_events')
    .select('id, event_type, format')
    .eq('tournament_id', tournamentId)
    .neq('id', eventId)
    .order('created_at');

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

  // Placement bonus amounts + master switch. The Results tab projects the
  // bonus column from final_position rather than reading stored history, so it
  // has to use the same numbers (and the same on/off decision) the finaliser
  // would — otherwise the panel says "off" while the table advertises +32.
  const bonusSettings = await getTournamentBonusSettings(supabase);

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
        siblingEvents={siblingEvents ?? []}
        isDoubles={doubles}
        bonusSettings={bonusSettings}
      />
    </div>
  );
}
