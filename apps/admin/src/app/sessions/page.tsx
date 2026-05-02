export const dynamic = 'force-dynamic';
import { createAdminClient } from '@/lib/supabase-server';
import { PageHero } from '@badminton/ui';
import { CreateSessionForm, SessionCardMenu, AttendanceDialog } from './actions';

type Session = {
  id: string;
  name: string | null;
  date: string;
  location: string;
  status: string;
  notes: string | null;
  capacity: number | null;
  start_time: string | null;
  end_time: string | null;
  featured: boolean | null;
};

type AttendanceRow = {
  session_id: string;
  player_id: string;
  checked_in_at: string;
  players: { full_name: string } | { full_name: string }[] | null;
};

export default async function SessionsPage() {
  const supabase = createAdminClient();

  const { data: sessions } = await supabase
    .from('sessions')
    .select('id, name, date, location, status, notes, capacity, start_time, end_time, featured')
    .order('date', { ascending: false })
    .limit(50);

  const list: Session[] = (sessions ?? []) as Session[];
  const sessionIds = list.map((s) => s.id);

  const { data: attendanceRows } =
    sessionIds.length > 0
      ? await supabase
          .from('session_attendance')
          .select('session_id, player_id, checked_in_at, players(full_name)')
          .in('session_id', sessionIds)
      : { data: [] as AttendanceRow[] };

  const attendanceMap: Record<
    string,
    Array<{ player_id: string; full_name: string; checked_in_at: string }>
  > = {};
  const countBySession: Record<string, number> = {};
  for (const row of (attendanceRows ?? []) as AttendanceRow[]) {
    const player = Array.isArray(row.players) ? row.players[0] : row.players;
    const sid = row.session_id;
    if (!attendanceMap[sid]) attendanceMap[sid] = [];
    attendanceMap[sid].push({
      player_id: row.player_id,
      full_name: player?.full_name ?? 'Unknown',
      checked_in_at: row.checked_in_at,
    });
    countBySession[sid] = (countBySession[sid] ?? 0) + 1;
  }

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const upcoming = list.filter((s) => new Date(s.date) >= today);
  const past = list.filter((s) => new Date(s.date) < today);

  return (
    <div>
      <PageHero
        eyebrow={`${upcoming.length} upcoming · ${past.length} past`}
        title="Sessions."
        subtitle="Open play, competitive nights, and league fixtures across SFU courts."
        watermark="S"
      />

      <div
        style={{
          display: 'flex',
          justifyContent: 'flex-end',
          padding: '20px 48px 0',
        }}
      >
        <CreateSessionForm />
      </div>

      <Section title="Upcoming">
        {upcoming.length === 0 ? (
          <Empty message="No upcoming sessions." />
        ) : (
          upcoming.map((s) => (
            <SessionRow
              key={s.id}
              session={s}
              going={countBySession[s.id] ?? 0}
              attendees={attendanceMap[s.id] ?? []}
            />
          ))
        )}
      </Section>

      {past.length > 0 && (
        <Section title="Past" subtitle="/ Last 50">
          {past.map((s) => (
            <SessionRow
              key={s.id}
              session={s}
              going={countBySession[s.id] ?? 0}
              attendees={attendanceMap[s.id] ?? []}
              past
            />
          ))}
        </Section>
      )}
    </div>
  );
}

function Section({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
}) {
  return (
    <div style={{ background: 'var(--surface1)', borderTop: '1px solid var(--hairline)' }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '20px 48px',
          borderBottom: '1px solid var(--hairline)',
        }}
      >
        <div
          style={{
            fontSize: 10,
            letterSpacing: '0.2em',
            textTransform: 'uppercase',
            color: 'var(--ink)',
            fontWeight: 700,
          }}
        >
          {title}
          {subtitle && <span style={{ color: 'var(--faint)', marginLeft: 8, fontWeight: 500 }}>{subtitle}</span>}
        </div>
      </div>
      {children}
    </div>
  );
}

function SessionRow({
  session,
  going,
  attendees,
  past,
}: {
  session: Session;
  going: number;
  attendees: Array<{ player_id: string; full_name: string; checked_in_at: string }>;
  past?: boolean;
}) {
  const capacity = session.capacity ?? 20;
  const isFull = going >= capacity;

  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: '2.2fr 1.6fr 1.2fr 0.9fr 0.9fr 0.8fr',
        alignItems: 'center',
        padding: '18px 48px',
        borderBottom: '1px solid var(--hairline-soft)',
        gap: 16,
        opacity: past ? 0.5 : 1,
      }}
    >
      <div style={{ fontSize: 14, color: 'var(--ink)', fontWeight: 500 }}>
        {session.name || 'Untitled Session'}
      </div>
      <div style={{ fontSize: 12, color: 'var(--muted)', letterSpacing: '0.02em' }}>
        {formatDate(session.date)}
      </div>
      <div style={{ fontSize: 12, color: 'var(--muted)', letterSpacing: '0.02em' }}>
        {session.location}
      </div>
      <div
        style={{
          fontFamily: 'var(--font-display)',
          fontWeight: 600,
          color: 'var(--ink)',
          fontSize: 14,
          fontVariantNumeric: 'tabular-nums',
        }}
      >
        {going} / {capacity}
      </div>
      <div>
        <SessionStatusBadge status={past ? 'completed' : isFull ? 'full' : session.status} />
      </div>
      <div style={{ textAlign: 'right', display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
        <AttendanceDialog sessionId={session.id} attendees={attendees} />
        <SessionCardMenu session={session} />
      </div>
    </div>
  );
}

type SessionBadgeConf = { c: string; bg: string; bd: string; label: string };

function SessionStatusBadge({ status }: { status: string }) {
  const map: Record<string, SessionBadgeConf> = {
    open: {
      c: '#4ade80',
      bg: 'rgba(74,222,128,0.08)',
      bd: 'rgba(74,222,128,0.18)',
      label: 'Open',
    },
    full: {
      c: 'var(--muted)',
      bg: 'rgba(255,255,255,0.05)',
      bd: 'var(--hairline)',
      label: 'Full',
    },
    closed: {
      c: 'var(--muted)',
      bg: 'rgba(255,255,255,0.05)',
      bd: 'var(--hairline)',
      label: 'Closed',
    },
    completed: {
      c: 'var(--muted)',
      bg: 'rgba(255,255,255,0.05)',
      bd: 'var(--hairline)',
      label: 'Completed',
    },
  };
  const fallback: SessionBadgeConf = {
    c: 'var(--muted)',
    bg: 'rgba(255,255,255,0.05)',
    bd: 'var(--hairline)',
    label: status,
  };
  const conf: SessionBadgeConf = map[status] ?? fallback;
  return (
    <span
      style={{
        display: 'inline-block',
        fontSize: 9,
        letterSpacing: '0.15em',
        textTransform: 'uppercase',
        fontWeight: 600,
        padding: '3px 8px',
        color: conf.c,
        background: conf.bg,
        border: `1px solid ${conf.bd}`,
        lineHeight: 1.2,
      }}
    >
      {conf.label}
    </span>
  );
}

function Empty({ message }: { message: string }) {
  return (
    <div
      style={{
        padding: '40px 48px',
        textAlign: 'center',
        color: 'var(--muted)',
        fontSize: 13,
      }}
    >
      {message}
    </div>
  );
}

function formatDate(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
  } catch {
    return iso;
  }
}
