import { createServerSupabaseClient, getCurrentPlayer } from '@/lib/supabase-server';
import { notFound, redirect } from 'next/navigation';
import Link from 'next/link';
import { ScreenHeader, SectionLabel } from '@/components/v2/atoms-layout';
import { Avatar, EmptyState, Pill } from '@/components/v2/atoms-display';
import { CheckInButton } from '../check-in-button';
import { SessionAttendeeGrid } from './attendee-grid';

// PHASE 8 REVERT: SessionAttendeeGrid was previously wrapped in
// next/dynamic({ ssr: false }) to defer pulling ChallengeSheet (~300kB) into
// the detail page's First Load JS. The wrapper sits inside this Server
// Component, which is the documented broken pattern in Next 14.x —
// mountLazyComponent corrupts on the second render after router.refresh()
// (e.g. after a check-in or accept-challenge action), crashing the page.
// Phase 8's own report noted the wrapper didn't shrink the bundle anyway
// (1.44KB → 1.86KB). Real interaction-gated lazy load is scheduled for
// Step 3d as part of the /sessions rebuild.

// TODO: Phase 10 — scope session reads + attendee resolution by
// organization_id once multi-club is supported.

type AttendeeRow = {
  player_id: string;
  player: {
    id: string;
    full_name: string;
    avatar_url: string | null;
    deleted_at: string | null;
    ratings: Array<{ singles_elo: number | null }> | { singles_elo: number | null } | null;
  } | null;
};

// The Supabase select string for this page is too rich for PostgREST type
// inference to handle (it falls back to a GenericStringError). Cast the
// returned row to the shape we actually depend on.
type SessionRow = {
  id: string;
  name: string | null;
  location: string | null;
  date: string;
  notes: string | null;
  status: string;
  capacity: number | null;
  start_time: string | null;
  end_time: string | null;
  featured: boolean | null;
  session_attendance: AttendeeRow[];
};

export default async function SessionDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const player = await getCurrentPlayer();
  if (!player) redirect('/login');

  const supabase = await createServerSupabaseClient();

  const { data: rawSession, error } = await supabase
    .from('sessions')
    .select(
      'id, name, location, date, notes, status, capacity, start_time, end_time, featured, ' +
        'session_attendance(player_id, player:players(id, full_name, avatar_url, deleted_at, ratings(singles_elo)))'
    )
    .eq('id', id)
    .maybeSingle();

  if (error || !rawSession) notFound();
  const session = rawSession as unknown as SessionRow;

  // A session is "past" once it's actually ended. Prefer end_time as the
  // truth (combined with the date for an absolute Date); fall back to the
  // session date alone (compared to today) when end_time is null on older
  // sessions seeded before the 00021 design-gap columns existed.
  const now = new Date();
  const isPast = computeIsPast(session.date, session.end_time, session.status, now);

  // Filter out soft-deleted attendees + sort by singles ELO desc.
  const attendanceRows = session.session_attendance ?? [];
  const attendees = attendanceRows
    .map((row) => row.player)
    .filter(
      (p): p is NonNullable<AttendeeRow['player']> => p != null && p.deleted_at == null
    )
    .map((p) => {
      const ratings = Array.isArray(p.ratings) ? p.ratings[0] : p.ratings;
      return {
        id: p.id,
        full_name: p.full_name,
        avatar_url: p.avatar_url,
        singles_elo: ratings?.singles_elo ?? null,
      };
    })
    .sort((a, b) => (b.singles_elo ?? -Infinity) - (a.singles_elo ?? -Infinity));

  const isCheckedIn = attendees.some((a) => a.id === player.id);
  const capacity = session.capacity ?? 20;
  const goingCount = attendees.length;
  const pct = Math.min(100, Math.round((goingCount / Math.max(1, capacity)) * 100));

  // Check-in window: open if session date is today or in the future and
  // status is open. Past sessions show a "final" attendance state with no
  // action button.
  const canCheckIn = !isPast && session.status === 'open';

  const dateLabel = formatDateRange(session.date, session.start_time, session.end_time);

  return (
    <>
      <div className="m-only">
        <BackBar />
        <ScreenHeader
          eyebrow={isPast ? 'Past session' : 'Open Play & Drills'}
          title={session.name ?? 'Session'}
        />

        {/* Header card — date / time / location / capacity */}
        <section style={{ padding: '0 24px 16px' }}>
          <div
            style={{
              background: 'var(--surface1)',
              border: '1px solid var(--hairline)',
              padding: 20,
              display: 'flex',
              flexDirection: 'column',
              gap: 14,
            }}
          >
            <Row label="When" value={dateLabel} />
            <Row label="Where" value={session.location ?? '—'} />
            <Row
              label="Going"
              value={`${goingCount} / ${capacity}`}
              hint={`${pct}% full`}
            />
            {isPast && (
              <Pill color="var(--text)" bg="rgba(255,255,255,0.05)" border="1px solid var(--hairline)">
                Session ended
              </Pill>
            )}
          </div>
        </section>

        {canCheckIn && !isCheckedIn && (
          <section style={{ padding: '0 24px 16px' }}>
            <CheckInButton sessionId={id} isCheckedIn={false} />
          </section>
        )}
        {canCheckIn && isCheckedIn && (
          <section style={{ padding: '0 24px 16px' }}>
            <CheckInButton sessionId={id} isCheckedIn />
          </section>
        )}

        {/* Attendee list — tap an attendee to challenge them. */}
        <section style={{ padding: '0 24px 24px' }}>
          <SectionLabel>
            {isPast ? 'Attended' : 'Going'} · {goingCount}
          </SectionLabel>
          {attendees.length === 0 ? (
            <EmptyState
              title={isPast ? 'No attendance recorded' : 'Nobody yet'}
              hint={isPast ? undefined : 'Be the first — tap RSVP above.'}
            />
          ) : (
            <SessionAttendeeGrid
              attendees={attendees}
              meId={player.id}
              allowChallenge={!isPast}
            />
          )}
        </section>
      </div>

      {/* DESKTOP — same data, simpler stack inside the d-only chrome. */}
      <div className="d-only">
        <DesktopBackLink />
        <div className="d-page-head">
          <div>
            <p className="eyebrow">{isPast ? 'Past session' : 'Open play'}</p>
            <h2>{(session.name as string) ?? 'Session'}</h2>
            <div className="d-meta">
              {dateLabel} · {(session.location as string) ?? 'TBD'} · {goingCount} / {capacity} going
            </div>
          </div>
          {canCheckIn && (
            <div className="d-page-head-actions">
              <CheckInButton sessionId={id} isCheckedIn={isCheckedIn} />
            </div>
          )}
        </div>

        <div className="d-ch-section">
          <h3>{isPast ? 'Attended' : 'Going'} · {goingCount}</h3>
          {attendees.length === 0 ? (
            <div className="d-empty">
              {isPast ? 'No attendance recorded.' : 'Nobody has checked in yet.'}
            </div>
          ) : (
            <SessionAttendeeGrid
              attendees={attendees}
              meId={player.id}
              allowChallenge={!isPast}
            />
          )}
        </div>
      </div>
    </>
  );
}

function Row({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 16 }}>
      <span
        style={{
          fontSize: 10,
          fontWeight: 600,
          letterSpacing: '1.6px',
          textTransform: 'uppercase',
          color: 'var(--text)',
        }}
      >
        {label}
      </span>
      <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--ink)', textAlign: 'right' }}>
        {value}
        {hint && (
          <span style={{ marginLeft: 8, color: 'var(--dim)', fontSize: 11, fontWeight: 500 }}>
            {hint}
          </span>
        )}
      </span>
    </div>
  );
}

function BackBar() {
  return (
    <div style={{ padding: '14px 24px 4px' }}>
      <Link
        href="/sessions"
        style={{
          fontSize: 11,
          color: 'var(--text)',
          textDecoration: 'none',
          letterSpacing: '0.08em',
          textTransform: 'uppercase',
          fontWeight: 600,
        }}
      >
        ← Sessions
      </Link>
    </div>
  );
}

function DesktopBackLink() {
  return (
    <div style={{ padding: '20px 48px 0' }}>
      <Link
        href="/sessions"
        style={{
          fontSize: 11,
          color: 'var(--text)',
          textDecoration: 'none',
          letterSpacing: '0.08em',
          textTransform: 'uppercase',
          fontWeight: 600,
        }}
      >
        ← Sessions
      </Link>
    </div>
  );
}

// Truth: a session is past once its end_time has elapsed. If end_time is
// null (legacy data), compare the session's date column to today's date —
// anything before today is past. status != 'open' (cancelled / archived /
// closed) is also past.
function computeIsPast(
  isoDate: string,
  endTime: string | null,
  status: string,
  now: Date
): boolean {
  if (status !== 'open') return true;
  if (endTime) {
    // end_time is 'HH:MM:SS' clock time on the session's date.
    const [h, m, s] = endTime.split(':').map((p) => parseInt(p, 10) || 0);
    const ends = new Date(isoDate);
    ends.setHours(h ?? 0, m ?? 0, s ?? 0, 0);
    return ends.getTime() < now.getTime();
  }
  // Fallback: same-day or future is "active"; previous day is "past".
  const d = new Date(isoDate);
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  d.setHours(0, 0, 0, 0);
  return d.getTime() < today.getTime();
}

// "Fri Mar 14 · 7:00 – 9:00 PM" — falls back gracefully when start/end_time
// are null (older sessions seeded without the 00021 columns).
function formatDateRange(
  isoDate: string,
  startTime: string | null,
  endTime: string | null
): string {
  const d = new Date(isoDate);
  const datePart = d.toLocaleDateString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  });
  if (!startTime) return datePart;
  const fmt = (t: string) => {
    // Postgres TIME comes back as 'HH:MM:SS' — drop the seconds.
    const [h, m] = t.split(':').map(Number);
    if (h == null || m == null) return t;
    const hour12 = h % 12 || 12;
    const ampm = h < 12 ? 'AM' : 'PM';
    return m === 0 ? `${hour12} ${ampm}` : `${hour12}:${String(m).padStart(2, '0')} ${ampm}`;
  };
  if (!endTime) return `${datePart} · ${fmt(startTime)}`;
  return `${datePart} · ${fmt(startTime)} – ${fmt(endTime)}`;
}
