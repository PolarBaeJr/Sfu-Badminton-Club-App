import { createServerSupabaseClient, getCurrentPlayer } from '@/lib/supabase-server';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { ScreenHeader } from '@/components/v2/atoms-layout';
import { Avatar, EmptyState, Pill } from '@/components/v2/atoms-display';
import { CheckInButton } from './check-in-button';
import { SESSION_SELECT_FIELDS } from '@/lib/queries/sessions';
import { DPageHead, DPanel } from '@/components/desktop/page-shell';

type SessionAttendee = { full_name: string | null; avatar_url: string | null };

export default async function SessionsPage() {
  const player = await getCurrentPlayer();
  if (!player) redirect('/login');

  const supabase = await createServerSupabaseClient();

  const [{ data: allSessions }, { data: myAttendance }, { data: attendanceCounts }] =
    await Promise.all([
      supabase
        .from('sessions')
        .select(SESSION_SELECT_FIELDS)
        .order('date', { ascending: true })
        .limit(80),
      supabase.from('session_attendance').select('session_id').eq('player_id', player.id),
      supabase.from('session_attendance_counts').select('session_id, count'),
    ]);

  const checkedInIds = new Set((myAttendance ?? []).map((r) => r.session_id));
  const countBySession: Record<string, number> = Object.fromEntries(
    (attendanceCounts ?? []).map((r) => [r.session_id, r.count as number])
  );

  const now = Date.now();
  const upcoming = (allSessions ?? []).filter(
    (s) => s.status === 'open' && new Date(s.date as string).getTime() >= now
  );
  const past = (allSessions ?? [])
    .filter((s) => s.status !== 'open' || new Date(s.date as string).getTime() < now)
    .sort((a, b) => new Date(b.date as string).getTime() - new Date(a.date as string).getTime())
    .slice(0, 6);

  // Featured: prefer the DB flag. Fall back to highest-attendance heuristic only
  // when no session in the result set is explicitly featured.
  const anyExplicitlyFeatured = upcoming.some(
    (s) => (s as unknown as { featured?: boolean | null }).featured === true
  );
  const ratios = upcoming.map((s) => {
    const going = countBySession[s.id] ?? 0;
    const cap = ((s as unknown as { capacity?: number | null }).capacity) ?? 20;
    return cap > 0 ? going / cap : 0;
  });
  const maxIdx =
    !anyExplicitlyFeatured && ratios.length > 0 ? ratios.indexOf(Math.max(...ratios)) : -1;

  return (
    <>
      <div className="m-only">
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
            const sessionRecord = s as unknown as { capacity?: number | null; featured?: boolean | null };
            const capacity = sessionRecord.capacity ?? 20;
            const isFeatured =
              sessionRecord.featured === true || (!anyExplicitlyFeatured && idx === maxIdx && going > 0);
            const pct = Math.min(100, Math.round((going / Math.max(1, capacity)) * 100));
            const attendance = ((s as { session_attendance?: Array<{ players: SessionAttendee | SessionAttendee[] | null }> }).session_attendance) ?? [];
            const attendees = attendance
              .map((row) => (Array.isArray(row.players) ? row.players[0] : row.players))
              .filter((p): p is SessionAttendee => !!p && !!p.full_name)
              .slice(0, 5);

            return (
              <div
                key={s.id}
                style={{
                  background: 'var(--surface1)',
                  border: '1px solid var(--hairline)',
                  borderLeft: isFeatured ? '3px solid var(--red)' : '3px solid transparent',
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
                        color: isFeatured ? 'var(--red)' : 'var(--text)',
                      }}
                    >
                      {formatDateLine(
                        s.date as string,
                        sessionRecord && (s as unknown as { start_time?: string | null }).start_time,
                        sessionRecord && (s as unknown as { end_time?: string | null }).end_time
                      )}
                    </span>
                    {isFeatured && (
                      <Pill
                        color="var(--red)"
                        bg="rgba(var(--red-rgb), 0.12)"
                        border="1px solid rgba(var(--red-rgb), 0.35)"
                      >
                        Featured
                      </Pill>
                    )}
                  </div>
                  <div style={{ fontSize: 18, fontWeight: 600, letterSpacing: '-0.2px', lineHeight: 1.2 }}>
                    {s.name ?? 'Practice Session'}
                  </div>
                  <div style={{ fontSize: 12, color: 'var(--text)', marginTop: 4 }}>{s.location}</div>

                  <div style={{ marginTop: 14 }}>
                    <div
                      style={{
                        display: 'flex',
                        justifyContent: 'space-between',
                        fontSize: 10,
                        fontWeight: 600,
                        letterSpacing: '0.65px',
                        textTransform: 'uppercase',
                        color: 'var(--text)',
                        marginBottom: 6,
                      }}
                    >
                      <span>
                        {going} / {capacity} going
                      </span>
                      <span>{pct}% full</span>
                    </div>
                    <div style={{ height: 4, background: 'var(--surface1)', overflow: 'hidden' }}>
                      <div
                        style={{
                          height: '100%',
                          width: `${pct}%`,
                          background: 'var(--red)',
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
                          style={{ marginLeft: i === 0 ? 0 : -8, border: '2px solid var(--surface1)' }}
                        >
                          <Avatar
                            name={p.full_name ?? ''}
                            src={p.avatar_url}
                            size={24}
                          />
                        </div>
                      ))}
                    </div>
                    <Link
                      href={`/sessions/${s.id}`}
                      style={{
                        fontSize: 10,
                        color: 'var(--text)',
                        textDecoration: 'none',
                        letterSpacing: '0.16em',
                        textTransform: 'uppercase',
                        fontWeight: 700,
                        padding: '8px 4px',
                      }}
                    >
                      Details →
                    </Link>
                    <CheckInButton sessionId={s.id} isCheckedIn={isGoing} />
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
      </div>{/* /.m-only */}

      {/* DESKTOP VIEW */}
      <div className="d-only">
        <DPageHead
          eyebrow={`${upcoming.length} upcoming · ${past.length} past`}
          title="Sessions."
          meta="Open play, competitive nights, and league fixtures. Tap join when a slot opens."
        />

        <DPanel label="Upcoming">
          {upcoming.length === 0 ? (
            <div style={{ padding: '32px 48px', color: 'var(--text-faint)', fontSize: 12 }}>
              No upcoming sessions — admins post sessions every week.
            </div>
          ) : (
            upcoming.map((s) => {
              const isGoing = checkedInIds.has(s.id);
              const going = countBySession[s.id] ?? 0;
              const sd = s as unknown as { capacity?: number | null; start_time?: string | null; end_time?: string | null };
              const capacity = sd.capacity ?? 20;
              const isFull = going >= capacity;
              return (
                <div key={s.id} className="d-session-row">
                  <div className="d-session-name" data-label="Session">
                    <Link
                      href={`/sessions/${s.id}`}
                      style={{ color: 'inherit', textDecoration: 'none' }}
                    >
                      {s.name ?? 'Practice Session'}
                    </Link>
                  </div>
                  <div className="d-session-cell" data-label="Time">
                    {formatDateLine(s.date as string, sd.start_time, sd.end_time)}
                  </div>
                  <div className="d-session-cell" data-label="Court">
                    {s.location ?? '—'}
                  </div>
                  <div className="d-session-cell d-cap" data-label="Capacity">
                    {going} / {capacity}
                  </div>
                  <div className="d-session-cell" data-label="Status">
                    <span className={`d-badge ${isFull ? 'd-full' : 'd-open'}`}>
                      {isFull ? 'Full' : 'Open'}
                    </span>
                  </div>
                  <div style={{ textAlign: 'right' }}>
                    {isGoing ? (
                      <span className="d-badge d-attended">✓ Going</span>
                    ) : isFull ? (
                      <button className="d-btn d-btn-ghost d-disabled" disabled style={{ padding: '8px 14px' }}>
                        Full
                      </button>
                    ) : (
                      <CheckInButton sessionId={s.id} isCheckedIn={false} />
                    )}
                  </div>
                </div>
              );
            })
          )}
        </DPanel>

        <DPanel label="Past" sublabel={`/ Last ${past.length}`}>
          {past.length === 0 ? (
            <div style={{ padding: '32px 48px', color: 'var(--text-faint)', fontSize: 12 }}>
              No past sessions yet.
            </div>
          ) : (
            past.map((s) => {
              const going = countBySession[s.id] ?? 0;
              const sd = s as unknown as { capacity?: number | null; start_time?: string | null; end_time?: string | null };
              const capacity = sd.capacity ?? 20;
              const wasGoing = checkedInIds.has(s.id);
              return (
                <div key={s.id} className="d-session-row d-past">
                  <div className="d-session-name" data-label="Session">
                    <Link
                      href={`/sessions/${s.id}`}
                      style={{ color: 'inherit', textDecoration: 'none' }}
                    >
                      {s.name ?? 'Practice Session'}
                    </Link>
                  </div>
                  <div className="d-session-cell" data-label="Date">
                    {formatDateLine(s.date as string, sd.start_time, sd.end_time)}
                  </div>
                  <div className="d-session-cell" data-label="Court">
                    {s.location ?? '—'}
                  </div>
                  <div className="d-session-cell d-cap" data-label="Capacity">
                    {going} / {capacity}
                  </div>
                  <div className="d-session-cell" data-label="Status">
                    <span className={`d-badge ${wasGoing ? 'd-attended' : 'd-completed'}`}>
                      {wasGoing ? 'Attended' : 'Completed'}
                    </span>
                  </div>
                  <div style={{ textAlign: 'right' }}>
                    <Link
                      href={`/sessions/${s.id}`}
                      className="d-view-all"
                      style={{ color: 'var(--text-secondary)' }}
                    >
                      Recap →
                    </Link>
                  </div>
                </div>
              );
            })
          )}
        </DPanel>
      </div>
    </>
  );
}

function formatDateLine(iso: string, startTime?: string | null, endTime?: string | null): string {
  try {
    const d = new Date(iso);
    const day = d.toLocaleDateString('en-US', { weekday: 'short' });
    const month = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    const datePart = `${day} · ${month}`;
    if (startTime) {
      const fmt = (t: string) => {
        const [h, m] = t.split(':');
        const hh = parseInt(h ?? '0', 10);
        const mm = parseInt(m ?? '0', 10);
        const ampm = hh >= 12 ? 'pm' : 'am';
        const hr = hh % 12 === 0 ? 12 : hh % 12;
        return mm === 0 ? `${hr}${ampm}` : `${hr}:${mm.toString().padStart(2, '0')}${ampm}`;
      };
      const startStr = fmt(startTime);
      if (endTime) {
        return `${datePart} · ${startStr}–${fmt(endTime)}`;
      }
      return `${datePart} · ${startStr}`;
    }
    return datePart;
  } catch {
    return iso;
  }
}
