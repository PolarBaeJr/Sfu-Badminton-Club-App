import { createServerSupabaseClient, getCurrentPlayer } from '@/lib/supabase-server';
import {
  formatDate,
  isDoublesEvent,
  TOURNAMENT_EVENT_TYPE_LABELS,
  TOURNAMENT_EVENT_STATUS_LABELS,
  TOURNAMENT_EVENT_STATUS_COLORS,
} from '@badminton/shared';
import type { TournamentEventType, TournamentEventStatus } from '@badminton/shared';
import { notFound } from 'next/navigation';
import { Award, Users, ChevronRight, Trophy, Zap, CalendarDays } from 'lucide-react';
import Link from 'next/link';
import { FadeIn, StaggerContainer, StaggerItem } from '@/components/motion-wrapper';
import { EventRegistrationButton } from './EventRegistrationButton';

const STATUS_VARIANT: Record<string, string> = {
  active:    'chip-success',
  completed: 'chip',
  upcoming:  'chip-gold',
  cancelled: 'chip',
};

export default async function TournamentDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await createServerSupabaseClient();

  const { data: tournament } = await supabase.from('tournaments').select('*').eq('id', id).single();
  if (!tournament) notFound();

  const { data: events } = await supabase
    .from('tournament_events')
    .select('*, tournament_participants(count), tournament_pairs(count)')
    .eq('tournament_id', id)
    .order('event_type');

  const currentPlayer = await getCurrentPlayer();
  const registrationMap: Record<string, { status: string }> = {};
  if (currentPlayer && events) {
    const eventIds = events.map(e => e.id);
    if (eventIds.length > 0) {
      const { data: regs } = await supabase
        .from('tournament_participants')
        .select('event_id, status')
        .eq('player_id', currentPlayer.id)
        .in('event_id', eventIds);
      for (const r of regs ?? []) {
        registrationMap[r.event_id] = { status: r.status };
      }
    }
  }

  return (
    <div className="space-y-5 pb-28 px-4 sm:px-0">
      <Link
        href="/tournaments"
        className="inline-flex items-center gap-1.5 text-sm text-[var(--text-muted)] hover:text-[var(--text-secondary)] transition-colors duration-150 group min-h-[44px] py-2"
      >
        <ChevronRight className="w-4 h-4 rotate-180 transition-transform duration-150 group-hover:-translate-x-0.5" />
        Back to Tournaments
      </Link>

      {/* Tournament Hero */}
      <FadeIn>
        <div className="card-elevated rounded-2xl overflow-hidden">
          <div className="h-1.5 gradient-gold" />
          <div className="p-5">
            <div className="flex items-start gap-3 mb-3">
              <div className="w-11 h-11 rounded-xl bg-[var(--color-gold)]/10 flex items-center justify-center shrink-0 glow-gold">
                <Trophy className="w-5 h-5 text-[var(--color-gold)]" />
              </div>
              <div className="min-w-0 flex-1">
                <p className="eyebrow">Tournament</p>
                <h1 className="display-lg leading-none truncate">{tournament.name}</h1>
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-2 text-sm text-[var(--text-muted)] mb-3">
              <span className="flex items-center gap-1.5">
                <CalendarDays className="w-3.5 h-3.5" />
                {formatDate(tournament.start_date)}
              </span>
              <span className="text-[var(--border-strong)]">&middot;</span>
              <span className="capitalize">{tournament.format}</span>
              <span className="text-[var(--border-strong)]">&middot;</span>
              <span className="capitalize">{tournament.scope}</span>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <span className={`chip ${STATUS_VARIANT[tournament.status] ?? 'chip'} capitalize`}>
                {tournament.status}
              </span>
              {tournament.scope === 'eligible_only' && (
                <span className="chip chip-info">
                  Eligible Only
                </span>
              )}
              <span className="chip chip-gold flex items-center gap-1">
                <Zap className="w-3 h-3" />
                {tournament.event_multiplier}x Multiplier
              </span>
            </div>
          </div>
        </div>
      </FadeIn>

      {/* Events */}
      <FadeIn delay={0.05}>
        <div className="flex items-center gap-2">
          <Award className="w-4 h-4 text-[var(--color-accent)]" />
          <h2 className="display-md">Events</h2>
        </div>
      </FadeIn>

      <StaggerContainer className="grid gap-4 sm:grid-cols-2">
        {events?.map((event) => {
          const eventType   = event.event_type as TournamentEventType;
          const eventStatus = event.status as TournamentEventStatus;
          const doubles     = isDoublesEvent(eventType);
          const participantCount = doubles
            ? (event.tournament_pairs as unknown as { count: number }[])?.[0]?.count ?? 0
            : (event.tournament_participants as unknown as { count: number }[])?.[0]?.count ?? 0;
          const statusColor = TOURNAMENT_EVENT_STATUS_COLORS[eventStatus];
          const myReg       = registrationMap[event.id] ?? null;

          return (
            <StaggerItem key={event.id}>
              <Link href={`/tournaments/${id}/events/${event.id}`} className="block h-full">
                <div className="card-surface card-interactive rounded-2xl p-5 h-full flex flex-col gap-3 group cursor-pointer min-h-[44px]">
                  <div className="flex items-start justify-between gap-2">
                    <div className="space-y-2 flex-1 min-w-0">
                      <h3 className="display-md leading-snug truncate">
                        {TOURNAMENT_EVENT_TYPE_LABELS[eventType]}
                      </h3>
                      <div className="flex flex-wrap items-center gap-2">
                        <span
                          className="chip"
                          style={{
                            borderColor: `${statusColor}50`,
                            background:  `${statusColor}18`,
                            color:        statusColor,
                          }}
                        >
                          {TOURNAMENT_EVENT_STATUS_LABELS[eventStatus]}
                        </span>
                        <span className="chip">
                          {event.format === 'single_elimination' ? 'SE' : 'RR'}
                        </span>
                      </div>
                    </div>
                    <ChevronRight className="w-5 h-5 text-[var(--text-muted)] group-hover:text-[var(--text-secondary)] transition-all duration-150 group-hover:translate-x-0.5 shrink-0 mt-0.5" />
                  </div>

                  <div className="flex items-center justify-between mt-auto pt-1 gap-2">
                    <div className="flex items-center gap-1.5 text-[var(--text-muted)]">
                      <Users className="w-3.5 h-3.5 shrink-0" />
                      <span className="text-xs">
                        {participantCount} {doubles ? 'pair' : 'player'}
                        {participantCount !== 1 ? 's' : ''}
                        {event.max_participants ? ` / ${event.max_participants}` : ''}
                      </span>
                    </div>
                    <div onClick={(e) => e.preventDefault()}>
                      <EventRegistrationButton
                        eventId={event.id}
                        eventStatus={eventStatus}
                        registration={myReg}
                        isDoubles={doubles}
                      />
                    </div>
                  </div>
                </div>
              </Link>
            </StaggerItem>
          );
        })}
      </StaggerContainer>

      {(!events || events.length === 0) && (
        <FadeIn delay={0.1}>
          <div className="card-surface rounded-2xl p-10 text-center">
            <Trophy className="w-10 h-10 text-[var(--border-strong)] mx-auto mb-3" />
            <p className="text-[var(--text-muted)] text-sm">No events have been created yet.</p>
          </div>
        </FadeIn>
      )}
    </div>
  );
}
