// Client/server mirror of the DB function session_checkin_open
// (00008_richer_attendance.sql). The DB function is the enforcement source of
// truth (RLS backstop); this exists so apps can show friendly window state
// without a round trip. All session wall-clock times are club-local
// (CLUB_TIMEZONE).
import {
  CLUB_TIMEZONE,
  SESSION_DEFAULT_DURATION_MINUTES,
  SESSION_CHECKIN_OPENS_MINUTES_BEFORE,
} from './constants';

export interface SessionWindowFields {
  date: string; // YYYY-MM-DD
  start_time?: string | null; // HH:MM[:SS]
  end_time?: string | null; // HH:MM[:SS]
  status?: string;
}

// Offset of CLUB_TIMEZONE (ms east of UTC) at a given UTC instant, via
// Intl.DateTimeFormat — no timezone dependency needed.
function tzOffsetMs(utcMillis: number): number {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: CLUB_TIMEZONE,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const parts: Record<string, string> = {};
  for (const p of dtf.formatToParts(new Date(utcMillis))) {
    parts[p.type] = p.value;
  }
  const asUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour),
    Number(parts.minute),
    Number(parts.second)
  );
  return asUtc - utcMillis;
}

// Convert a club-local wall-clock time to a UTC instant using the standard
// two-pass technique: guess the offset at the naive-UTC reading of the wall
// clock, then re-derive it at the corrected instant (handles DST edges).
export function wallClockToUtc(year: number, month: number, day: number, hour: number, minute: number): Date {
  const naiveUtc = Date.UTC(year, month - 1, day, hour, minute);
  const offset1 = tzOffsetMs(naiveUtc);
  const offset2 = tzOffsetMs(naiveUtc - offset1);
  return new Date(naiveUtc - offset2);
}

function parseTime(time: string): { hour: number; minute: number } {
  const [h, m] = time.split(':');
  return { hour: Number(h), minute: Number(m ?? '0') };
}

// Same rules as session_checkin_open: close at date + end_time if set, else
// start_time + default duration if start_time is set, else end of the
// session's date (start of the next day, club time). opensAt is null when
// SESSION_CHECKIN_OPENS_MINUTES_BEFORE is null (no opening edge).
export function getCheckinWindow(session: SessionWindowFields): {
  opensAt: Date | null;
  closesAt: Date;
} {
  const [y, mo, d] = session.date.split('-').map(Number) as [number, number, number];
  const start = parseTime(session.start_time ?? '00:00');
  const startAt = wallClockToUtc(y, mo, d, start.hour, start.minute);

  let closesAt: Date;
  if (session.end_time) {
    const end = parseTime(session.end_time);
    closesAt = wallClockToUtc(y, mo, d, end.hour, end.minute);
  } else if (session.start_time) {
    closesAt = new Date(startAt.getTime() + SESSION_DEFAULT_DURATION_MINUTES * 60_000);
  } else {
    // Date.UTC normalizes day overflow, so d + 1 rolls month/year correctly.
    closesAt = wallClockToUtc(y, mo, d + 1, 0, 0);
  }

  const opensAt =
    SESSION_CHECKIN_OPENS_MINUTES_BEFORE == null
      ? null
      : new Date(startAt.getTime() - SESSION_CHECKIN_OPENS_MINUTES_BEFORE * 60_000);

  return { opensAt, closesAt };
}

export function isCheckinOpen(session: SessionWindowFields, now: Date = new Date()): boolean {
  if (session.status !== undefined && session.status !== 'open') return false;
  const { opensAt, closesAt } = getCheckinWindow(session);
  if (opensAt && now < opensAt) return false;
  return now < closesAt;
}
