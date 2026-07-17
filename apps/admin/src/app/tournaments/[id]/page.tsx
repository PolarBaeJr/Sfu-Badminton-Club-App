import { createAdminClient } from '@/lib/supabase-server';
import { Card, Badge } from '@badminton/ui';
import { formatDate, TOURNAMENT_EVENT_TYPE_LABELS, TOURNAMENT_EVENT_STATUS_LABELS, TOURNAMENT_EVENT_STATUS_COLORS } from '@badminton/shared';
import { notFound } from 'next/navigation';
import { ArrowLeft, Trophy, Users, Calendar, Zap, Crown, Plus, Swords, DollarSign } from 'lucide-react';
import Link from 'next/link';
import { CreateEventButton } from './create-event';
import { TournamentStatusControls } from './tournament-status-controls';

export default async function TournamentDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = createAdminClient();

  const { data: tournament } = await supabase.from('tournaments').select('*').eq('id', id).single();
  if (!tournament) notFound();

  // Fetch events with participant counts
  const { data: events } = await supabase
    .from('tournament_events')
    .select('*')
    .eq('tournament_id', id)
    .order('created_at');

  // Get participant counts per event (batch queries instead of N+1)
  const eventCounts: Record<string, number> = {};
  if (events && events.length > 0) {
    const eventIds = events.map(ev => ev.id);
    const [{ data: participantRows }, { data: pairRows }] = await Promise.all([
      supabase.from('tournament_participants')
        .select('event_id')
        .in('event_id', eventIds)
        .not('status', 'eq', 'withdrawn'),
      supabase.from('tournament_pairs')
        .select('event_id')
        .in('event_id', eventIds)
        .not('status', 'eq', 'withdrawn'),
    ]);
    for (const ev of events) {
      const isDoubles = ['mens_doubles', 'womens_doubles', 'mixed_doubles', 'open_doubles'].includes(ev.event_type);
      if (isDoubles) {
        eventCounts[ev.id] = pairRows?.filter(r => r.event_id === ev.id).length ?? 0;
      } else {
        eventCounts[ev.id] = participantRows?.filter(r => r.event_id === ev.id).length ?? 0;
      }
    }
  }

  return (
    <div className="space-y-6">
      {/* Back link */}
      <Link href="/tournaments" className="inline-flex items-center gap-1.5 text-sm text-[var(--text-muted)] hover:text-[var(--color-accent)] transition-colors focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-blue-500 focus-visible:outline-none rounded">
        <ArrowLeft className="w-4 h-4" />
        Back to Tournaments
      </Link>

      {/* Header */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-lg bg-[var(--color-accent)]/10 flex items-center justify-center">
              <Trophy className="w-5 h-5 text-[var(--color-accent)]" />
            </div>
            <h1 className="text-3xl font-bold font-display text-[var(--text-primary)]">{tournament.name}</h1>
          </div>
          <div className="flex items-center gap-3 mt-2 ml-[52px] text-sm text-[var(--text-muted)]">
            <span className="flex items-center gap-1"><Calendar className="w-3.5 h-3.5" />{formatDate(tournament.start_date)}</span>
            <span>&middot;</span>
            <span>{tournament.format}</span>
            <span>&middot;</span>
            <span className="flex items-center gap-1"><Zap className="w-3 h-3" />{tournament.event_multiplier}x</span>
          </div>
          <div className="flex gap-2 mt-3 ml-[52px]">
            <Badge variant={tournament.status === 'active' ? 'success' : tournament.status === 'completed' ? 'neutral' : 'warning'}>
              <span className="sr-only">Tournament status: </span>{tournament.status}
            </Badge>
            {tournament.scope === 'eligible_only' && <Badge variant="info">Eligible Only</Badge>}
            {tournament.placement_bonus_enabled && <Badge variant="default">Placement Bonuses</Badge>}
          </div>
        </div>
        <div className="flex items-center gap-3">
          <Link href={`/tournaments/${id}/fees`} className="inline-flex items-center gap-1.5 text-sm text-[var(--text-muted)] hover:text-[var(--color-accent)] transition-colors focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-blue-500 focus-visible:outline-none rounded">
            <DollarSign className="w-4 h-4" />
            Fees
          </Link>
          <TournamentStatusControls tournamentId={id} status={tournament.status} />
        </div>
      </div>

      {/* Events Section */}
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Swords className="w-4 h-4 text-[var(--text-muted)]" />
            <h2 className="text-lg font-semibold text-[var(--text-primary)]">Events ({events?.length ?? 0})</h2>
          </div>
          {(tournament.status === 'draft' || tournament.status === 'active') && (
            <CreateEventButton tournamentId={id} />
          )}
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {events?.map((ev) => {
            const statusColor = TOURNAMENT_EVENT_STATUS_COLORS[ev.status as keyof typeof TOURNAMENT_EVENT_STATUS_COLORS] ?? '#6B7280';
            return (
              <Link key={ev.id} href={`/tournaments/${id}/events/${ev.id}`} className="block group focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-blue-500 focus-visible:outline-none rounded-xl">
                <div className="rounded-xl border border-[var(--border)] bg-[var(--bg-card)] p-5 hover:border-[var(--color-accent)]/30 transition-all">
                  <div className="flex items-start justify-between mb-3">
                    <h3 className="text-base font-semibold text-[var(--text-primary)] group-hover:text-[var(--color-accent)] transition-colors">
                      {TOURNAMENT_EVENT_TYPE_LABELS[ev.event_type as keyof typeof TOURNAMENT_EVENT_TYPE_LABELS] ?? ev.event_type}
                    </h3>
                    <span
                      className="text-xs font-medium px-2 py-0.5 rounded-full"
                      role="status"
                      style={{ color: statusColor, backgroundColor: `${statusColor}15` }}
                    >
                      <span className="sr-only">Event status: </span>{TOURNAMENT_EVENT_STATUS_LABELS[ev.status as keyof typeof TOURNAMENT_EVENT_STATUS_LABELS] ?? ev.status}
                    </span>
                  </div>
                  <div className="flex items-center gap-3 text-sm text-[var(--text-muted)]">
                    <span className="capitalize">{ev.format.replace('_', ' ')}</span>
                    <span>&middot;</span>
                    <span className="flex items-center gap-1">
                      <Users className="w-3.5 h-3.5" />
                      {eventCounts[ev.id] ?? 0}{ev.max_participants ? `/${ev.max_participants}` : ''}
                    </span>
                    <span>&middot;</span>
                    <span>{ev.match_format.replace(/_/g, ' ')}</span>
                  </div>
                </div>
              </Link>
            );
          })}
        </div>

        {(!events || events.length === 0) && (
          <div className="rounded-xl border border-[var(--border)] bg-[var(--bg-card)] p-8 text-center">
            <Swords className="w-8 h-8 mx-auto mb-3 text-[var(--text-muted)] opacity-50" />
            <p className="text-sm text-[var(--text-muted)]">
              No events yet. {tournament.status === 'draft' ? 'Add events to this tournament to get started.' : ''}
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
