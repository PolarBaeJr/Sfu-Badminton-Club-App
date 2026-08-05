import { createServerSupabaseClient, getCurrentPlayer } from '@/lib/supabase-server';
import {
  formatDate,
  isDoublesEvent,
  TOURNAMENT_EVENT_TYPE_LABELS,
  TOURNAMENT_EVENT_STATUS_LABELS,
  TOURNAMENT_STATUS_TAG,
  hasTournamentEnded,
} from '@badminton/shared';
import type { TournamentEventType, TournamentEventStatus } from '@badminton/shared';
import { notFound } from 'next/navigation';
import { Trophy, Users, Zap, ArrowLeft, ChevronRight } from 'lucide-react';
import Link from 'next/link';
import { EventRegistrationButton } from './EventRegistrationButton';
import { FeedbackForm } from './feedback-form';

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
    const eventIds = events.map((e) => e.id);
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

  // The current player's existing feedback for this tournament, if any.
  let myFeedback: { rating: number | null; comment: string | null } | null = null;
  if (currentPlayer) {
    const { data: fb } = await supabase
      .from('event_feedback')
      .select('rating, comment')
      .eq('tournament_id', id)
      .eq('player_id', currentPlayer.id)
      .maybeSingle();
    myFeedback = (fb as { rating: number | null; comment: string | null } | null) ?? null;
  }

  return (
    <div data-screen-label="Tournament">
      <div className="page-header" style={{ marginBottom: 18 }}>
        <Link href="/tournaments" className="row press" style={{ gap: 8, fontSize: 13, color: 'var(--mute)' }}>
          <ArrowLeft size={16} />
          Back to tournaments
        </Link>
      </div>

      <div className="card-base" style={{ marginBottom: 20 }}>
        <div className="card-head" style={{ alignItems: 'flex-start' }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className="page-eyebrow" style={{ marginBottom: 4 }}>
              <span className="bar" /> TOURNAMENT
            </div>
            <h1
              style={{
                fontFamily: 'var(--display)',
                fontSize: 30,
                fontWeight: 700,
                letterSpacing: '-.02em',
                margin: 0,
              }}
            >
              {tournament.name}
            </h1>
            <div className="row" style={{ gap: 8, marginTop: 8, flexWrap: 'wrap', fontSize: 12 }}>
              <span className="mono muted">{formatDate(tournament.start_date)}</span>
              <span className="muted">·</span>
              <span className="muted" style={{ textTransform: 'capitalize' }}>{tournament.format}</span>
              <span className="muted">·</span>
              <span className="muted" style={{ textTransform: 'capitalize' }}>{tournament.scope}</span>
            </div>
          </div>
          <div className="row" style={{ gap: 6, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
            <span className={TOURNAMENT_STATUS_TAG[tournament.status as string] ?? 'tag'}>
              {(tournament.status as string)?.toUpperCase()}
            </span>
            {tournament.suspended_at && <span className="tag tag-red">SUSPENDED</span>}
          </div>
        </div>
        <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
          {tournament.scope === 'eligible_only' && <span className="tag">ELIGIBLE ONLY</span>}
          <span className="tag tag-gold row" style={{ gap: 4 }}>
            <Zap size={10} /> {tournament.event_multiplier}× MULTIPLIER
          </span>
        </div>
      </div>

      {tournament.suspended_at && (
        <div className="card-base" style={{ marginBottom: 20 }} role="status">
          <div className="card-head" style={{ marginBottom: 0 }}>
            <h3 className="card-title">Tournament suspended</h3>
            <span className="tag tag-red">PAUSED</span>
          </div>
          <p className="muted" style={{ fontSize: 13, margin: 0 }}>
            Registration and check-in are paused
            {tournament.suspension_reason ? `: ${tournament.suspension_reason}` : ' until further notice.'}
          </p>
        </div>
      )}

      <div className="card-head" style={{ marginBottom: 14 }}>
        <h3 className="card-title">Events</h3>
        {events && events.length > 0 && <span className="tag">{events.length}</span>}
      </div>

      {(!events || events.length === 0) ? (
        <div className="card-base">
          <div className="empty">
            <Trophy size={40} className="text-[var(--mute)]" style={{ display: 'block', margin: '0 auto 12px' }} />
            No events have been created yet.
          </div>
        </div>
      ) : (
        <div className="grid grid-2">
          {events.map((event) => {
            const eventType = event.event_type as TournamentEventType;
            const eventStatus = event.status as TournamentEventStatus;
            const doubles = isDoublesEvent(eventType);
            const participantCount = doubles
              ? (event.tournament_pairs as unknown as { count: number }[])?.[0]?.count ?? 0
              : (event.tournament_participants as unknown as { count: number }[])?.[0]?.count ?? 0;
            const myReg = registrationMap[event.id] ?? null;

            return (
              <div
                key={event.id}
                style={{
                  padding: 18,
                  border: '1px solid var(--line)',
                  borderRadius: 'var(--r-lg)',
                  background: 'var(--surface)',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 14,
                }}
              >
                <Link href={`/tournaments/${id}/events/${event.id}`} className="press" style={{ textDecoration: 'none' }}>
                  <div className="row" style={{ alignItems: 'flex-start' }}>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div
                        style={{
                          fontFamily: 'var(--display)',
                          fontSize: 18,
                          fontWeight: 600,
                          letterSpacing: '-.01em',
                        }}
                      >
                        {TOURNAMENT_EVENT_TYPE_LABELS[eventType]}
                      </div>
                      <div className="row" style={{ gap: 8, marginTop: 8, flexWrap: 'wrap' }}>
                        <span className={TOURNAMENT_STATUS_TAG[eventStatus] ?? 'tag'}>
                          {TOURNAMENT_EVENT_STATUS_LABELS[eventStatus]?.toUpperCase()}
                        </span>
                        <span className="tag">
                          {event.format === 'single_elimination' ? 'SINGLE ELIM' : 'ROUND ROBIN'}
                        </span>
                      </div>
                    </div>
                    <ChevronRight size={16} className="text-[var(--mute)]" />
                  </div>
                </Link>

                <div className="row" style={{ gap: 10, justifyContent: 'space-between' }}>
                  <div className="row" style={{ gap: 6, fontSize: 12 }}>
                    <Users size={12} className="text-[var(--mute)]" />
                    <span className="mono muted">
                      {participantCount} {doubles ? 'pair' : 'player'}{participantCount !== 1 ? 's' : ''}
                      {event.max_participants ? ` / ${event.max_participants}` : ''}
                    </span>
                  </div>
                  <EventRegistrationButton
                    eventId={event.id}
                    eventStatus={eventStatus}
                    registration={myReg}
                    isDoubles={doubles}
                    suspended={!!tournament.suspended_at}
                    eventWaiverText={tournament.waiver_text}
                  />
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Only once the event is over. Rating a tournament that has not happened
          yet is not feedback, and it is the exec team's only read on how an
          event actually went. The server action enforces the same rule. */}
      {currentPlayer && hasTournamentEnded(tournament) && (
        <div style={{ marginTop: 24 }}>
          <FeedbackForm
            tournamentId={id}
            initialRating={myFeedback?.rating ?? null}
            initialComment={myFeedback?.comment ?? null}
          />
        </div>
      )}
    </div>
  );
}
