import { createAdminClient } from '@/lib/supabase-server';
import { notFound } from 'next/navigation';
import { TOURNAMENT_EVENT_TYPE_LABELS, isDoublesEvent } from '@badminton/shared';
import { ArrowLeft } from 'lucide-react';
import Link from 'next/link';
import { EventControlCenter } from './components/EventControlCenter';

export default async function EventPage({
  params,
}: {
  params: Promise<{ id: string; eventId: string }>;
}) {
  const { id: tournamentId, eventId } = await params;
  const supabase = createAdminClient();

  // Tournament + event share the notFound guard, so fetch them in parallel.
  const [tournamentRes, eventRes] = await Promise.all([
    supabase.from('tournaments').select('*').eq('id', tournamentId).single(),
    supabase.from('tournament_events').select('*').eq('id', eventId).single(),
  ]);
  const tournament = tournamentRes.data;
  const event = eventRes.data;
  if (!tournament) notFound();
  if (!event) notFound();

  const doubles = isDoublesEvent(event.event_type);

  // Fetch participants/pairs, matches, and the player roster all in parallel —
  // they're independent and previously ran sequentially (3 round-trips serial).
  const participantsOrPairsPromise = doubles
    ? supabase
        .from('tournament_pairs')
        .select('*, player1:players!tournament_pairs_player1_id_fkey(id, full_name, avatar_url), player2:players!tournament_pairs_player2_id_fkey(id, full_name, avatar_url)')
        .eq('event_id', eventId)
        .order('seed_number', { ascending: true, nullsFirst: false })
    : supabase
        .from('tournament_participants')
        .select('*, player:players(id, full_name, avatar_url, ratings(singles_elo, doubles_elo, singles_provisional, doubles_provisional, singles_matches_played, doubles_matches_played))')
        .eq('event_id', eventId)
        .order('seed_number', { ascending: true, nullsFirst: false });

  const [partsRes, matchesRes, playersRes] = await Promise.all([
    participantsOrPairsPromise,
    supabase
      .from('tournament_matches')
      .select('*')
      .eq('event_id', eventId)
      .order('round_number')
      .order('bracket_position'),
    supabase
      .from('players')
      .select('id, full_name')
      .not('status', 'in', '("suspended","pending_approval")')
      .order('full_name'),
  ]);

  // Cast through unknown — Supabase generated row types don't expose every
  // joined column; the tournament types include `[key: string]: unknown` to
  // accept the row shape and let components access expected fields safely.
  const participants = (doubles ? [] : (partsRes.data ?? [])) as unknown as import('@/app/tournaments/types').TournamentParticipant[];
  const pairs = (doubles ? (partsRes.data ?? []) : []) as unknown as import('@/app/tournaments/types').TournamentPair[];
  const matches = (matchesRes.data ?? []) as unknown as import('@/app/tournaments/types').TournamentMatch[];
  const allPlayers = (playersRes.data ?? []) as Array<{ id: string; full_name: string }>;

  return (
    <div className="space-y-6">
      <Link
        href={`/tournaments/${tournamentId}`}
        className="inline-flex items-center gap-1.5 text-sm text-[var(--text-muted)] hover:text-[var(--ds-accent)] transition-colors"
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
