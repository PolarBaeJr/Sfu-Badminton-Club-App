import { createServerSupabaseClient } from '@/lib/supabase-server';
import { Badge } from '@badminton/ui';
import {
  formatDate,
  isDoublesEvent,
  TOURNAMENT_EVENT_TYPE_LABELS,
  TOURNAMENT_EVENT_STATUS_LABELS,
  TOURNAMENT_EVENT_STATUS_COLORS,
} from '@badminton/shared';
import type { TournamentEventType, TournamentEventStatus } from '@badminton/shared';
import { notFound } from 'next/navigation';
import { Award, Users, ChevronRight, Trophy, Zap } from 'lucide-react';
import Link from 'next/link';
import { FadeIn, StaggerContainer, StaggerItem } from '@/components/motion-wrapper';

export default async function TournamentDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await createServerSupabaseClient();

  const { data: tournament } = await supabase.from('tournaments').select('*').eq('id', id).single();
  if (!tournament) notFound();

  // Try fetching events (new schema) — returns null if migration hasn't run
  const { data: events } = await supabase
    .from('tournament_events')
    .select('*, tournament_participants(count), tournament_pairs(count)')
    .eq('tournament_id', id)
    .order('event_type');

  return (
    <div className="space-y-6">
      <Link
        href="/tournaments"
        className="inline-flex items-center gap-1.5 text-sm text-[#64748B] hover:text-[#94A3B8] transition-colors"
      >
        <ChevronRight className="w-4 h-4 rotate-180" />
        Back to Tournaments
      </Link>

      <FadeIn>
        <div className="bg-[#161B2E] border border-white/[0.06] rounded-xl p-6">
          <div className="flex items-center gap-3 mb-2">
            <Trophy className="w-6 h-6 text-[#FFD700]" />
            <h1 className="text-2xl font-black text-shuttle-white font-display tracking-wide">
              {tournament.name}
            </h1>
          </div>
          <p className="text-sm text-[#64748B] mt-1">
            {formatDate(tournament.start_date)} &middot; {tournament.format} &middot; {tournament.scope}
          </p>
          <div className="flex items-center gap-3 mt-3">
            <Badge
              variant={
                tournament.status === 'active'
                  ? 'success'
                  : tournament.status === 'completed'
                    ? 'neutral'
                    : 'warning'
              }
            >
              {tournament.status}
            </Badge>
            {tournament.scope === 'eligible_only' && <Badge variant="info">Eligible Only</Badge>}
            <span className="flex items-center gap-1 text-xs text-[#FFD700]">
              <Zap className="w-3 h-3" />
              {tournament.event_multiplier}x
            </span>
          </div>
        </div>
      </FadeIn>

      {/* Events */}
      <FadeIn delay={0.05}>
        <div className="flex items-center gap-2 mb-4">
          <Award className="w-4 h-4 text-[#EF4444]" />
          <h2 className="text-sm font-bold text-shuttle-white uppercase tracking-wider font-display">
            Events
          </h2>
        </div>
      </FadeIn>

      <StaggerContainer className="grid gap-4 sm:grid-cols-2">
        {events?.map((event) => {
          const eventType = event.event_type as TournamentEventType;
          const eventStatus = event.status as TournamentEventStatus;
          const doubles = isDoublesEvent(eventType);
          const participantCount = doubles
            ? (event.tournament_pairs as unknown as { count: number }[])?.[0]?.count ?? 0
            : (event.tournament_participants as unknown as { count: number }[])?.[0]?.count ?? 0;
          const statusColor = TOURNAMENT_EVENT_STATUS_COLORS[eventStatus];

          return (
            <StaggerItem key={event.id}>
              <Link href={`/tournaments/${id}/events/${event.id}`}>
                <div className="bg-[#161B2E] border border-white/[0.06] rounded-xl p-5 hover:border-white/[0.12] transition-colors group cursor-pointer">
                  <div className="flex items-start justify-between">
                    <div className="space-y-2">
                      <h3 className="text-base font-bold text-shuttle-white font-display">
                        {TOURNAMENT_EVENT_TYPE_LABELS[eventType]}
                      </h3>
                      <div className="flex items-center gap-2 flex-wrap">
                        <span
                          className="inline-flex items-center text-xs font-semibold px-2 py-0.5 rounded-full"
                          style={{
                            backgroundColor: `${statusColor}20`,
                            color: statusColor,
                          }}
                        >
                          {TOURNAMENT_EVENT_STATUS_LABELS[eventStatus]}
                        </span>
                        <Badge variant="neutral">
                          {event.format === 'single_elimination' ? 'Single Elimination' : 'Round Robin'}
                        </Badge>
                      </div>
                    </div>
                    <ChevronRight className="w-5 h-5 text-[#64748B] group-hover:text-[#94A3B8] transition-colors mt-1" />
                  </div>

                  <div className="flex items-center gap-1.5 mt-4 text-[#64748B]">
                    <Users className="w-3.5 h-3.5" />
                    <span className="text-xs">
                      {participantCount} {doubles ? 'pair' : 'player'}
                      {participantCount !== 1 ? 's' : ''}
                      {event.max_participants ? ` / ${event.max_participants} max` : ''}
                    </span>
                  </div>
                </div>
              </Link>
            </StaggerItem>
          );
        })}
      </StaggerContainer>

      {(!events || events.length === 0) && (
        <FadeIn delay={0.1}>
          <div className="bg-[#161B2E] border border-white/[0.06] rounded-xl p-8 text-center">
            <p className="text-[#64748B] text-sm">No events have been created for this tournament yet.</p>
          </div>
        </FadeIn>
      )}
    </div>
  );
}
