import { createServerSupabaseClient, getCurrentPlayer } from '@/lib/supabase-server';
import { CLUB_TIMEZONE, formatDate, formatTime, getCheckinWindow, isCheckinOpen, type AttendanceStatus, type SessionIntent } from '@badminton/shared';
import { redirect } from 'next/navigation';
import { Calendar, MapPin, FileText, Users, UserCheck, Clock } from 'lucide-react';
import { PageHeader } from '@badminton/ui';
import { CheckInButton } from './check-in-button';
import { AddToCalendarButton } from './add-to-calendar';
import { RsvpButtons } from './rsvp-buttons';
import { DeepLinkScroll } from './deep-link-scroll';

export default async function SessionsPage() {
  const player = await getCurrentPlayer();
  if (!player) redirect('/login');

  const supabase = await createServerSupabaseClient();

  const [{ data: openSessions }, { data: closedSessions }, { data: myAttendance }, { data: attendanceCounts }, { data: myRsvp }, { data: goingCounts }] = await Promise.all([
    supabase
      .from('sessions')
      .select('*')
      .eq('status', 'open')
      .in('track', [player.status, 'all'])
      .order('date', { ascending: false }),
    supabase
      .from('sessions')
      .select('*')
      .eq('status', 'closed')
      .in('track', [player.status, 'all'])
      .order('date', { ascending: false })
      .limit(10),
    supabase
      .from('session_attendance')
      .select('session_id, status')
      .eq('player_id', player.id),
    // Attendee counts shown on cards exclude admin-marked no-show/excused rows.
    supabase
      .from('session_attendance')
      .select('session_id')
      .in('status', ['checked_in', 'present'])
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
    supabase
      .from('session_rsvp')
      .select('session_id, intent')
      .eq('player_id', player.id),
    supabase
      .from('session_rsvp')
      .select('session_id')
      .eq('intent', 'going')
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

  const myStatusBySession = new Map<string, AttendanceStatus>(
    (myAttendance ?? []).map((r) => [r.session_id as string, r.status as AttendanceStatus])
  );
  const countBySession = Object.fromEntries(
    (attendanceCounts ?? []).map((r) => [r.session_id, r.count])
  );
  const myIntentBySession = new Map<string, SessionIntent>(
    (myRsvp ?? []).map((r) => [r.session_id as string, r.intent as SessionIntent])
  );
  const goingBySession = Object.fromEntries(
    (goingCounts ?? []).map((r) => [r.session_id, r.count])
  );

  const upcomingCount = openSessions?.length ?? 0;

  return (
    <div data-screen-label="Schedule">
      <DeepLinkScroll />
      <PageHeader
        title="Schedule"
        sub="Open practices, drop-ins, and ladder nights. Sign in to claim a court spot — capacity fills fast."
      />

      <div className="feed-col">
        <div className="card-base reveal reveal-1">
          <div className="card-head">
            <div>
              <h3 className="card-title">Upcoming</h3>
              <div className="card-sub">{upcomingCount === 0 ? 'No sessions on the calendar.' : `${upcomingCount} session${upcomingCount === 1 ? '' : 's'} accepting check-ins.`}</div>
            </div>
            {upcomingCount > 0 && <span className="tag tag-win">{upcomingCount} OPEN</span>}
          </div>
          {upcomingCount === 0 ? (
            <div className="empty">
              <div className="empty-icon"><Calendar size={20} /></div>
              <div className="empty-title">No upcoming sessions</div>
              <div className="empty-hint">
                New practices are posted here — check back soon or watch announcements.
              </div>
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              {(openSessions ?? []).map((session) => {
                const myStatus = myStatusBySession.get(session.id) ?? null;
                const attendees = countBySession[session.id] ?? 0;
                const now = new Date();
                const canCheckIn = isCheckinOpen(session, now);
                const { opensAt } = getCheckinWindow(session);
                let windowLabel: string | undefined;
                if (!canCheckIn) {
                  if (opensAt && now < opensAt) {
                    // Club-local HH:MM of the opening instant, rendered like session times.
                    const opensLocal = opensAt.toLocaleTimeString('en-GB', {
                      timeZone: CLUB_TIMEZONE,
                      hourCycle: 'h23',
                      hour: '2-digit',
                      minute: '2-digit',
                    });
                    windowLabel = `Opens at ${formatTime(opensLocal)}`;
                  } else {
                    windowLabel = 'Check-in closed';
                  }
                }
                return (
                  <div
                    key={session.id}
                    id={`session-${session.id}`}
                    style={{
                      padding: 18,
                      border: '1px solid var(--line)',
                      borderRadius: 'var(--r-lg)',
                      background: 'var(--surface)',
                    }}
                    className="session-card"
                  >
                    <div
                      className="session-grid"
                      style={{
                        display: 'flex',
                        flexDirection: 'column',
                        gap: 16,
                      }}
                    >
                      <div>
                        <div className="card-title card-title-lg">
                          {session.name ?? 'Practice Session'}
                        </div>
                        <div className="session-meta" style={{ flexWrap: 'wrap' }}>
                          <span className="row" style={{ gap: 6 }}>
                            <Calendar size={14} /> <span className="mono">{formatDate(session.date).toUpperCase()}</span>
                          </span>
                          {session.start_time && (
                            <span className="row" style={{ gap: 6 }}>
                              <Clock size={14} />{' '}
                              <span className="mono">
                                {formatTime(session.start_time)}
                                {session.end_time ? ` – ${formatTime(session.end_time)}` : ''}
                              </span>
                            </span>
                          )}
                          <span className="row" style={{ gap: 6 }}>
                            <MapPin size={14} /> <span>{session.location}</span>
                          </span>
                          <span className="row" style={{ gap: 6 }}>
                            <Users size={14} /> <span className="mono">{attendees} attending</span>
                          </span>
                          <span className="row" style={{ gap: 6 }}>
                            <UserCheck size={14} /> <span className="mono">{goingBySession[session.id] ?? 0} going</span>
                          </span>
                        </div>
                        {session.notes && (
                          <div className="row" style={{ gap: 6, fontSize: 13, color: 'var(--ink-2)', marginTop: 10, alignItems: 'flex-start' }}>
                            <FileText size={14} className="text-[var(--mute)]" style={{ marginTop: 2, flexShrink: 0 }} />
                            <span>{session.notes}</span>
                          </div>
                        )}
                      </div>
                      <div style={{ display: 'flex', flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 8 }}>
                        <CheckInButton sessionId={session.id} myStatus={myStatus} canCheckIn={canCheckIn} windowLabel={windowLabel} myIntent={myIntentBySession.get(session.id) ?? null} />
                        <RsvpButtons sessionId={session.id} myIntent={myIntentBySession.get(session.id) ?? null} />
                        <AddToCalendarButton
                          name={session.name ?? 'Practice Session'}
                          date={session.date}
                          start_time={session.start_time}
                          end_time={session.end_time}
                          location={session.location}
                          notes={session.notes}
                        />
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {closedSessions && closedSessions.length > 0 && (
          <div className="card-base reveal reveal-2">
            <div className="card-head">
              <h3 className="card-title">Past sessions</h3>
              <div className="card-sub">Last {closedSessions.length} closed.</div>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {closedSessions.map((session) => (
                <div
                  key={session.id}
                  style={{ opacity: 0.7 }}
                  className="list-row"
                >
                  <div style={{ flex: 1 }}>
                    <div className="row-title">{session.name ?? 'Practice Session'}</div>
                    <div className="row-sub">
                      {formatDate(session.date).toUpperCase()} · {session.location}
                    </div>
                  </div>
                  <span className="tag">CLOSED</span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
