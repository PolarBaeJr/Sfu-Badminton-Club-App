import { createServerSupabaseClient, getCurrentPlayer } from '@/lib/supabase-server';
import { redirect } from 'next/navigation';
import { Avatar, ScreenHeader, Pill, EmptyState } from '@/components/v2/atoms';
import { CheckInButton } from './check-in-button';

type SessionAttendee = { full_name: string | null; avatar_url: string | null };

export default async function SessionsPage() {
  const player = await getCurrentPlayer();
  if (!player) redirect('/login');

  const supabase = await createServerSupabaseClient();

  const [{ data: openSessions }, { data: myAttendance }, { data: attendanceCounts }] =
    await Promise.all([
      supabase
        .from('sessions')
        .select('id, name, location, date, notes, status, session_attendance(player_id, players:players(full_name, avatar_url))')
        .in('status', ['open', 'closed'])
        .order('date', { ascending: true })
        .limit(40),
      supabase.from('session_attendance').select('session_id').eq('player_id', player.id),
      supabase.from('session_attendance_counts').select('session_id, count'),
    ]);

  const checkedInIds = new Set((myAttendance ?? []).map((r) => r.session_id));
  const countBySession: Record<string, number> = Object.fromEntries(
    (attendanceCounts ?? []).map((r) => [r.session_id, r.count as number])
  );

  const upcoming = (openSessions ?? []).filter((s) => s.status === 'open');

  // Featured = highest registration ratio against the (hardcoded) 16 capacity.
  const ratios = upcoming.map((s) => {
    const going = countBySession[s.id] ?? 0;
    return going / 16;
  });
  const maxIdx = ratios.length > 0 ? ratios.indexOf(Math.max(...ratios)) : -1;

  return (
    <>
      <ScreenHeader eyebrow="Open Play & Drills" title="Sessions" />
      {upcoming.length === 0 ? (
        <EmptyState
          title="No upcoming sessions"
          hint="Check back soon — admins post sessions every week."
        />
      ) : (
        <div style={{ padding: '0 24px 24px', display: 'flex', flexDirection: 'column', gap: 12 }}>
          {upcoming.map((s, idx) => {
            const isGoing = checkedInIds.has(s.id);
            const going = countBySession[s.id] ?? 0;
            const capacity = 16;
            const isFeatured = idx === maxIdx && going > 0;
            const pct = Math.min(100, Math.round((going / capacity) * 100));
            const attendance = ((s as { session_attendance?: Array<{ players: SessionAttendee | SessionAttendee[] | null }> }).session_attendance) ?? [];
            const attendees = attendance
              .map((row) => (Array.isArray(row.players) ? row.players[0] : row.players))
              .filter((p): p is SessionAttendee => !!p && !!p.full_name)
              .slice(0, 5);

            return (
              <div
                key={s.id}
                style={{
                  background: '#222',
                  border: '1px solid #303030',
                  borderLeft: isFeatured ? '3px solid #da291c' : '3px solid transparent',
                  overflow: 'hidden',
                }}
              >
                <div style={{ padding: 20, paddingLeft: isFeatured ? 17 : 20 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
                    <span
                      style={{
                        fontSize: 10,
                        fontWeight: 700,
                        letterSpacing: '1.6px',
                        textTransform: 'uppercase',
                        color: isFeatured ? '#da291c' : '#969696',
                      }}
                    >
                      {formatDateLine(s.date as string)}
                    </span>
                    {isFeatured && (
                      <Pill
                        color="#da291c"
                        bg="rgba(218,41,28,0.12)"
                        border="1px solid rgba(218,41,28,0.35)"
                      >
                        Featured
                      </Pill>
                    )}
                  </div>
                  <div style={{ fontSize: 18, fontWeight: 600, letterSpacing: '-0.2px', lineHeight: 1.2 }}>
                    {s.name ?? 'Practice Session'}
                  </div>
                  <div style={{ fontSize: 12, color: '#969696', marginTop: 4 }}>{s.location}</div>

                  <div style={{ marginTop: 14 }}>
                    <div
                      style={{
                        display: 'flex',
                        justifyContent: 'space-between',
                        fontSize: 10,
                        fontWeight: 600,
                        letterSpacing: '0.65px',
                        textTransform: 'uppercase',
                        color: '#969696',
                        marginBottom: 6,
                      }}
                    >
                      <span>
                        {going} / {capacity} going
                      </span>
                      <span>{pct}% full</span>
                    </div>
                    <div style={{ height: 4, background: '#181818', overflow: 'hidden' }}>
                      <div
                        style={{
                          height: '100%',
                          width: `${pct}%`,
                          background: '#da291c',
                          transition: 'width 240ms ease',
                        }}
                      />
                    </div>
                  </div>

                  <div style={{ marginTop: 16, display: 'flex', alignItems: 'center', gap: 12 }}>
                    <div style={{ display: 'flex', flex: 1 }}>
                      {attendees.map((p, i) => (
                        <div
                          key={i}
                          style={{ marginLeft: i === 0 ? 0 : -8, border: '2px solid #222' }}
                        >
                          <Avatar
                            name={p.full_name ?? ''}
                            src={p.avatar_url}
                            size={24}
                          />
                        </div>
                      ))}
                    </div>
                    <CheckInButton sessionId={s.id} isCheckedIn={isGoing} />
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </>
  );
}

function formatDateLine(iso: string): string {
  try {
    const d = new Date(iso);
    const day = d.toLocaleDateString('en-US', { weekday: 'short' });
    const month = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    return `${day} · ${month}`;
  } catch {
    return iso;
  }
}
