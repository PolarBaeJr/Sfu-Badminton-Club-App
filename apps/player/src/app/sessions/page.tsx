import { createServerSupabaseClient, getCurrentPlayer } from '@/lib/supabase-server';
import { formatDate } from '@badminton/shared';
import { redirect } from 'next/navigation';
import { Calendar, MapPin, FileText, Users } from 'lucide-react';
import { PageHeader } from '@badminton/ui';
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

  const upcomingCount = openSessions?.length ?? 0;

  return (
    <div data-screen-label="Sessions">
      <PageHeader
        eyebrow="PRACTICE · SCHEDULE"
        title="Sessions"
        sub="Open practices, drop-ins, and ladder nights. Sign in to claim a court spot — capacity fills fast."
      />

      <div className="feed-col">
        <div className="card-base">
          <div className="card-head">
            <div>
              <h3 className="card-title">Upcoming</h3>
              <div className="card-sub">{upcomingCount === 0 ? 'No sessions on the calendar.' : `${upcomingCount} session${upcomingCount === 1 ? '' : 's'} accepting check-ins.`}</div>
            </div>
            {upcomingCount > 0 && <span className="tag tag-win">{upcomingCount} OPEN</span>}
          </div>
          {upcomingCount === 0 ? (
            <div className="empty">No upcoming sessions. Check back later.</div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              {(openSessions ?? []).map((session) => {
                const isCheckedIn = checkedInSessionIds.has(session.id);
                const attendees = countBySession[session.id] ?? 0;
                return (
                  <div
                    key={session.id}
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
                        display: 'grid',
                        gridTemplateColumns: '1fr auto',
                        gap: 16,
                        alignItems: 'flex-start',
                      }}
                    >
                      <div>
                        <div style={{ fontFamily: 'var(--display)', fontSize: 20, fontWeight: 600, marginBottom: 6 }}>
                          {session.name ?? 'Practice Session'}
                        </div>
                        <div className="session-meta" style={{ flexWrap: 'wrap' }}>
                          <span className="row" style={{ gap: 6 }}>
                            <Calendar size={14} /> <span className="mono">{formatDate(session.date).toUpperCase()}</span>
                          </span>
                          <span className="row" style={{ gap: 6 }}>
                            <MapPin size={14} /> <span>{session.location}</span>
                          </span>
                          <span className="row" style={{ gap: 6 }}>
                            <Users size={14} /> <span className="mono">{attendees} attending</span>
                          </span>
                        </div>
                        {session.notes && (
                          <div className="row" style={{ gap: 6, fontSize: 13, color: 'var(--ink-2)', marginTop: 10, alignItems: 'flex-start' }}>
                            <FileText size={14} className="text-[var(--mute)]" style={{ marginTop: 2, flexShrink: 0 }} />
                            <span>{session.notes}</span>
                          </div>
                        )}
                      </div>
                      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 8 }}>
                        <span className="tag tag-win">OPEN</span>
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
                );
              })}
            </div>
          )}
        </div>

        {closedSessions && closedSessions.length > 0 && (
          <div className="card-base">
            <div className="card-head">
              <h3 className="card-title">Past sessions</h3>
              <div className="card-sub">Last {closedSessions.length} closed.</div>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {closedSessions.map((session) => (
                <div
                  key={session.id}
                  style={{
                    padding: '12px 14px',
                    border: '1px solid var(--line)',
                    borderRadius: 10,
                    background: 'var(--surface)',
                    opacity: 0.7,
                  }}
                  className="row"
                >
                  <div style={{ flex: 1 }}>
                    <div style={{ fontWeight: 600, fontSize: 13 }}>{session.name ?? 'Practice Session'}</div>
                    <div className="mono muted" style={{ fontSize: 11 }}>
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
