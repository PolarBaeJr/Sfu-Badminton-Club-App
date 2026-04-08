import { createServerSupabaseClient, getCurrentPlayer } from '@/lib/supabase-server';
import { Badge } from '@badminton/ui';
import { formatDate } from '@badminton/shared';
import { redirect } from 'next/navigation';
import { Calendar, MapPin, FileText, Users } from 'lucide-react';
import { FadeIn, StaggerContainer, StaggerItem } from '@/components/motion-wrapper';
import { CheckInButton } from './check-in-button';
import { AddToCalendarButton } from './add-to-calendar';

export default async function SessionsPage() {
  const player = await getCurrentPlayer();
  if (!player) redirect('/login');

  const supabase = await createServerSupabaseClient();

  const [{ data: openSessions }, { data: closedSessions }, { data: myAttendance }, { data: attendanceCounts }] = await Promise.all([
    supabase
      .from('sessions')
      .select('*')
      .eq('status', 'open')
      .order('date', { ascending: false }),
    supabase
      .from('sessions')
      .select('*')
      .eq('status', 'closed')
      .order('date', { ascending: false })
      .limit(10),
    supabase
      .from('session_attendance')
      .select('session_id')
      .eq('player_id', player.id),
    supabase
      .from('session_attendance')
      .select('session_id')
      .then(({ data, error }) => ({
        data: data
          ? Object.entries(
              data.reduce<Record<string, number>>((acc, row) => {
                acc[row.session_id] = (acc[row.session_id] ?? 0) + 1;
                return acc;
              }, {})
            ).map(([session_id, count]) => ({ session_id, count }))
          : null,
        error,
      })),
  ]);

  const checkedInSessionIds = new Set((myAttendance ?? []).map((r) => r.session_id));
  const countBySession = Object.fromEntries(
    (attendanceCounts ?? []).map((r) => [r.session_id, r.count])
  );

  return (
    <div className="space-y-6 pb-28">
      {/* Header */}
      <FadeIn>
        <div className="flex items-center gap-3 reveal reveal-1">
          <div className="w-9 h-9 rounded-xl bg-[var(--color-accent)]/10 flex items-center justify-center">
            <Calendar className="w-4 h-4 text-court-red" />
          </div>
          <div>
            <p className="eyebrow">Practice</p>
            <h1 className="display-lg text-shuttle-white">Sessions</h1>
          </div>
        </div>
      </FadeIn>

      {/* Upcoming Sessions */}
      <FadeIn delay={0.05}>
        <div>
          <div className="flex items-center gap-2 mb-3">
            <h2 className="eyebrow text-[var(--text-primary)]">Upcoming Sessions</h2>
            {openSessions && openSessions.length > 0 && (
              <span className="chip chip-success">{openSessions.length}</span>
            )}
          </div>

          {openSessions && openSessions.length > 0 ? (
            <StaggerContainer className="space-y-3">
              {openSessions.map((session) => {
                const isCheckedIn = checkedInSessionIds.has(session.id);
                const attendeeCount = countBySession[session.id] ?? 0;
                return (
                  <StaggerItem key={session.id}>
                    <div className="card-surface card-interactive p-4">
                      <div className="flex items-start justify-between gap-3">
                        <div className="flex-1 min-w-0">
                          <p className="text-sm font-semibold text-shuttle-white truncate">
                            {session.name ?? 'Practice Session'}
                          </p>
                          <div className="mt-2 space-y-1.5">
                            <div className="flex items-center gap-1.5">
                              <Calendar className="w-3.5 h-3.5 text-[var(--text-muted)] shrink-0" />
                              <span className="text-xs text-[var(--text-muted)]">
                                {formatDate(session.date)}
                              </span>
                            </div>
                            <div className="flex items-center gap-1.5">
                              <MapPin className="w-3.5 h-3.5 text-[var(--text-muted)] shrink-0" />
                              <span className="text-xs text-[var(--text-muted)] truncate">
                                {session.location}
                              </span>
                            </div>
                            {session.notes && (
                              <div className="flex items-start gap-1.5">
                                <FileText className="w-3.5 h-3.5 text-[var(--text-muted)] shrink-0 mt-0.5" />
                                <span className="text-xs text-[var(--text-muted)] line-clamp-2">
                                  {session.notes}
                                </span>
                              </div>
                            )}
                            <div className="flex items-center gap-1.5">
                              <Users className="w-3.5 h-3.5 text-[var(--text-muted)] shrink-0" />
                              <span className="nums text-xs text-[var(--text-muted)]">
                                {attendeeCount} attending
                              </span>
                            </div>
                          </div>
                        </div>
                        <div className="flex flex-col items-end gap-2 shrink-0">
                          <Badge variant="success">Open</Badge>
                          <CheckInButton sessionId={session.id} isCheckedIn={isCheckedIn} />
                          <AddToCalendarButton
                            name={session.name ?? 'Practice Session'}
                            date={session.date}
                            location={session.location}
                            notes={session.notes}
                          />
                        </div>
                      </div>
                    </div>
                  </StaggerItem>
                );
              })}
            </StaggerContainer>
          ) : (
            <div className="card-elevated p-8 flex flex-col items-center justify-center text-center">
              <Calendar className="w-9 h-9 text-[var(--text-dim)] mb-3" />
              <p className="text-sm font-semibold text-shuttle-white mb-1">No upcoming sessions</p>
              <p className="text-xs text-[var(--text-muted)]">Check back later for new sessions.</p>
            </div>
          )}
        </div>
      </FadeIn>

      {/* Past Sessions */}
      {closedSessions && closedSessions.length > 0 && (
        <FadeIn delay={0.15}>
          <div>
            <h2 className="eyebrow mb-3">Past Sessions</h2>
            <StaggerContainer className="space-y-2">
              {closedSessions.map((session) => (
                <StaggerItem key={session.id}>
                  <div className="bg-[var(--bg-card)]/60 border border-white/[0.04] rounded-xl p-3 opacity-60">
                    <div className="flex items-center justify-between gap-3">
                      <div className="flex-1 min-w-0">
                        <p className="text-xs font-semibold text-shuttle-white truncate">
                          {session.name ?? 'Practice Session'}
                        </p>
                        <div className="mt-1 flex items-center gap-3">
                          <div className="flex items-center gap-1">
                            <Calendar className="w-3 h-3 text-[var(--text-muted)] shrink-0" />
                            <span className="text-xs text-[var(--text-muted)]">
                              {formatDate(session.date)}
                            </span>
                          </div>
                          <div className="flex items-center gap-1">
                            <MapPin className="w-3 h-3 text-[var(--text-muted)] shrink-0" />
                            <span className="text-xs text-[var(--text-muted)] truncate">
                              {session.location}
                            </span>
                          </div>
                        </div>
                      </div>
                      <Badge variant="neutral">Closed</Badge>
                    </div>
                  </div>
                </StaggerItem>
              ))}
            </StaggerContainer>
          </div>
        </FadeIn>
      )}
    </div>
  );
}
