// Pure derivations behind the /sessions screen.
//
// They live here rather than inside the page so they can be unit-tested
// without a database, and — more importantly for this screen — so the
// day labels are computed in exactly one place. "Today" / "Tomorrow" is
// `new Date()`-relative text, and the page renders on the server: if a client
// component recomputed the same label from the browser's clock, a member in a
// different timezone (or one whose tab was open past midnight) would see two
// different answers on the same screen. Everything below takes the club-local
// "today" as an argument, so there is only ever one clock reading per render
// and it happens on the server.

import { CLUB_TIMEZONE, type AttendanceStatus, type SessionIntent } from '@badminton/shared';

/**
 * The club-local calendar date (YYYY-MM-DD) at a given instant. `sessions.date`
 * is a bare DATE in club time, so "is this today?" has to be asked in club
 * time too — comparing against the server container's UTC date would flip the
 * answer for every evening session between 5pm and midnight Vancouver time.
 */
export function clubDateISO(now: Date): string {
  // en-CA is the locale whose numeric date format IS ISO order.
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: CLUB_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function parseISODate(dateISO: string): { y: number; m: number; d: number } {
  const parts = dateISO.split('-');
  return { y: Number(parts[0]), m: Number(parts[1]), d: Number(parts[2]) };
}

/**
 * Calendar arithmetic on a bare YYYY-MM-DD, done entirely in UTC. The dates
 * here are wall-clock club dates with no time component, so anchoring them at
 * UTC midnight keeps `+1 day` from ever landing on the wrong side of a DST
 * change or of the host machine's own timezone.
 */
export function addDaysISO(dateISO: string, days: number): string {
  const { y, m, d } = parseISODate(dateISO);
  const shifted = new Date(Date.UTC(y, m - 1, d) + days * 86_400_000);
  const mm = String(shifted.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(shifted.getUTCDate()).padStart(2, '0');
  return `${shifted.getUTCFullYear()}-${mm}-${dd}`;
}

export interface DayHeading {
  /** "Today", "Tomorrow", or a weekday — the fast read. */
  label: string;
  /** "14 Aug" — always shown as well, so a relative word is never the only anchor. */
  dateLabel: string;
  isToday: boolean;
  isTomorrow: boolean;
}

export function dayHeading(dateISO: string, todayISO: string): DayHeading {
  const { y, m, d } = parseISODate(dateISO);
  const weekday = WEEKDAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()] ?? '';
  const dateLabel = `${d} ${MONTHS[m - 1] ?? ''}`;
  const isToday = dateISO === todayISO;
  const isTomorrow = dateISO === addDaysISO(todayISO, 1);
  return {
    label: isToday ? 'Today' : isTomorrow ? 'Tomorrow' : weekday,
    dateLabel,
    isToday,
    isTomorrow,
  };
}

export interface DayGroup<T> extends DayHeading {
  dateISO: string;
  sessions: T[];
}

/**
 * Sessions bucketed by their club-local date, oldest first, with the order
 * inside each day left exactly as the query returned it. A day is the unit a
 * member actually plans in — "am I playing tonight?" is the question this
 * screen answers first — so the grouping is the layout, not a decoration.
 */
export function groupSessionsByDay<T extends { date: string }>(
  sessions: readonly T[],
  todayISO: string
): DayGroup<T>[] {
  const byDate = new Map<string, T[]>();
  for (const session of sessions) {
    const bucket = byDate.get(session.date);
    if (bucket) bucket.push(session);
    else byDate.set(session.date, [session]);
  }
  return [...byDate.keys()]
    .sort()
    .map((dateISO) => ({
      dateISO,
      sessions: byDate.get(dateISO) ?? [],
      ...dayHeading(dateISO, todayISO),
    }));
}

/**
 * How many rows each session_id has. Used for both the "checked in" tally
 * (session_attendance) and the "going" tally (session_rsvp) — same shape, and
 * a shared helper means one of them cannot silently drift from the other.
 */
export function tallyBySession(rows: readonly { session_id: string }[] | null): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const row of rows ?? []) {
    counts[row.session_id] = (counts[row.session_id] ?? 0) + 1;
  }
  return counts;
}

export type MyState = 'checked_in' | 'attended' | 'no_show' | 'excused' | 'going' | 'declined' | 'none';

/**
 * The single answer to "am I in?", which is the thing this screen exists to
 * tell someone. Attendance always outranks RSVP: once a member has actually
 * turned up (or been marked absent) their earlier intent is history, and
 * showing "Checked in" next to "Not going" would just look broken.
 */
export function describeMyState(
  status: AttendanceStatus | null | undefined,
  intent: SessionIntent | null | undefined
): MyState {
  if (status === 'checked_in') return 'checked_in';
  if (status === 'present') return 'attended';
  if (status === 'no_show') return 'no_show';
  if (status === 'excused') return 'excused';
  if (intent === 'going') return 'going';
  if (intent === 'declined') return 'declined';
  return 'none';
}

/** True once attendance is on the record, which is what retires the RSVP controls. */
export function isAttendanceRecorded(status: AttendanceStatus | null | undefined): boolean {
  return status === 'checked_in' || status === 'present' || status === 'no_show' || status === 'excused';
}
