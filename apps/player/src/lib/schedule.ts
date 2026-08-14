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

// ───────────────────────────────────────────────────────────────────────────
// MONTH GRID
//
// The /sessions main column is a month calendar, and every date on it is
// resolved HERE, on the server, for the same reason the day headings are: the
// month nav is a client component, and a browser that re-derived "today" or
// re-walked the grid from its own clock could disagree with the schedule
// beside it. The client is handed finished cells and only picks which month
// to show.
//
// All arithmetic goes through addDaysISO / Date.UTC, never a local-time Date
// constructor. That is what makes 2026-11-01 — the day British Columbia's
// winter fall-back disappears (CLUB_PERMANENT_OFFSET_FROM in
// session-window.ts) — a non-event here: a grid anchored at UTC midnight and
// advanced in whole 86_400_000ms steps never consults tzdata at all, so it
// cannot double-count or drop a day across that boundary no matter which
// tzdata release the host happens to carry.
// ───────────────────────────────────────────────────────────────────────────

const MONTHS_FULL = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

/** Sunday-first column headers, matching the grid built below. */
export const CALENDAR_WEEKDAYS = WEEKDAYS;

/** The 'YYYY-MM' bucket a club-local date falls in. */
export function monthKeyOf(dateISO: string): string {
  return dateISO.slice(0, 7);
}

/**
 * Every 'YYYY-MM' from `loISO`'s month to `hiISO`'s month, inclusive.
 *
 * Returns a single month when both fall in the same one, and an empty list
 * when hi precedes lo — which callers treat as "nothing to navigate". The 600
 * iteration cap is a guard against one bad date in the data turning a season
 * into a fifty-year walk, not a policy; no real season comes near it.
 */
export function monthKeysBetween(loISO: string, hiISO: string): string[] {
  const hi = monthKeyOf(hiISO);
  let y = Number(loISO.slice(0, 4));
  let m = Number(loISO.slice(5, 7));
  const keys: string[] = [];
  for (let guard = 0; guard < 600; guard += 1) {
    const key = `${y}-${String(m).padStart(2, '0')}`;
    if (key > hi) break;
    keys.push(key);
    m += 1;
    if (m > 12) {
      m = 1;
      y += 1;
    }
  }
  return keys;
}

/**
 * No real term runs longer than a year. A span wider than this did not come
 * from a season; it came from a typo in `end_date`, and the cap is what stops
 * one from turning the arrows into a fifty-year walk.
 */
const SEASON_RUN_MONTH_CAP = 12;

/**
 * The months the calendar's arrows can reach.
 *
 * The naive answer — every month from the earliest loaded date to the latest —
 * is what this replaces, and it was wrong for one specific reason: the page
 * loads the active season's sessions PLUS every session with no season on it,
 * and those season-less rows are fetched regardless of date. One night left
 * over from a term two years ago therefore stretched the run to include every
 * month in between, and the member got two dozen blank grids to walk through.
 *
 * A season-less session is a real state, not junk — it is a night an exec
 * posted before opening the term, and it appears in the rail — so it is NOT
 * dropped. What is dropped is the empty span it used to drag behind it:
 *
 *   • Inside the active term the run stays CONTIGUOUS. A month with no
 *     sessions in it is worth showing there — "are we playing the week after
 *     reading break?" is answered by an empty grid just as well as a full one,
 *     and that question is why this calendar exists.
 *   • Outside it, only the months that actually HOLD a session are reachable.
 *     A stray night from 2024 gets its own September 2024 and nothing else, so
 *     the arrows step from it straight back to the term.
 *
 * With no active season the caller loads every session ever recorded, so there
 * is no term to be contiguous across and only the months with sessions in them
 * are listed. With nothing loaded at all the answer is today's month: one
 * honestly empty grid beats no calendar.
 */
export function calendarMonthKeys(
  season: { startISO: string; endISO: string | null } | null,
  seasonSessionDates: readonly string[],
  looseSessionDates: readonly string[],
  todayISO: string
): string[] {
  const keys = new Set<string>();

  if (season) {
    // The term's own span, widened by any of its sessions that fall outside
    // start/end (end_date is nullable, so a running term is bounded by its last
    // night). Sorting strings is sorting dates — they are all YYYY-MM-DD.
    const bounds = [
      season.startISO,
      ...(season.endISO ? [season.endISO] : []),
      ...seasonSessionDates,
    ].sort();
    const run = monthKeysBetween(bounds[0] as string, bounds[bounds.length - 1] as string);
    // +1 because the cap counts months AFTER the first: a 12-month term
    // occupies 13 keys.
    for (const key of run.slice(0, SEASON_RUN_MONTH_CAP + 1)) keys.add(key);
  }

  // Every session gets its own month whatever the run decided — including a
  // season-less one, and including an in-season one past the cap above. No
  // night is ever unreachable on the calendar it appears on.
  for (const dateISO of seasonSessionDates) keys.add(monthKeyOf(dateISO));
  for (const dateISO of looseSessionDates) keys.add(monthKeyOf(dateISO));

  if (keys.size === 0) keys.add(monthKeyOf(todayISO));
  return [...keys].sort();
}

export interface CalendarCell<T> {
  dateISO: string;
  /** Day of the month, as shown in the corner of the cell. */
  day: number;
  /** False for the leading/trailing days borrowed from the neighbouring months. */
  inMonth: boolean;
  isToday: boolean;
  sessions: T[];
}

export interface CalendarMonth<T> {
  /** 'YYYY-MM' — the key the client navigates by. */
  key: string;
  /** "August 2026". */
  label: string;
  weeks: CalendarCell<T>[][];
}

/**
 * One Sunday-first month grid — 4 to 6 whole weeks — with each session filed
 * under its club-local date.
 *
 * Sessions attach ONLY to days inside the month. The leading and trailing
 * cells exist to square the grid off; hanging a session on one of them would
 * print the same night in two different months, and anyone counting "how many
 * nights in September" would count it twice.
 */
export function buildCalendarMonth<T extends { date: string }>(
  monthKey: string,
  sessions: readonly T[],
  todayISO: string
): CalendarMonth<T> {
  const y = Number(monthKey.slice(0, 4));
  const m = Number(monthKey.slice(5, 7));

  // getUTCDay on a UTC-midnight anchor: 0 = Sunday, which is column 0.
  const leading = new Date(Date.UTC(y, m - 1, 1)).getUTCDay();
  // Day 0 of the NEXT month is the last day of this one.
  const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const weekCount = Math.ceil((leading + daysInMonth) / 7);
  const firstCell = addDaysISO(`${monthKey}-01`, -leading);

  const byDate = new Map<string, T[]>();
  for (const session of sessions) {
    if (monthKeyOf(session.date) !== monthKey) continue;
    const bucket = byDate.get(session.date);
    if (bucket) bucket.push(session);
    else byDate.set(session.date, [session]);
  }

  const weeks: CalendarCell<T>[][] = [];
  for (let w = 0; w < weekCount; w += 1) {
    const week: CalendarCell<T>[] = [];
    for (let d = 0; d < 7; d += 1) {
      const dateISO = addDaysISO(firstCell, w * 7 + d);
      week.push({
        dateISO,
        day: Number(dateISO.slice(8, 10)),
        inMonth: monthKeyOf(dateISO) === monthKey,
        isToday: dateISO === todayISO,
        sessions: byDate.get(dateISO) ?? [],
      });
    }
    weeks.push(week);
  }

  return { key: monthKey, label: `${MONTHS_FULL[m - 1] ?? monthKey} ${y}`, weeks };
}

/**
 * The month the calendar opens on: today's, or the next one the list actually
 * has. A member reading this page over the summer break — after the season's
 * last night — lands on the last month with anything in it, rather than on an
 * empty August with both arrows dead.
 *
 * "The next one" rather than "today's, clamped", because calendarMonthKeys can
 * return a list with HOLES in it: a stale season-less night from 2024 is one
 * reachable month years before the term. Clamping compared only against the
 * first key, so reading this page in August 2026 with a 2024 stray and a
 * September term opened on DECEMBER — past the far end, three back-presses from
 * the nights the member came to see. Scanning forward for the first month at or
 * after today gets September, and because the list is sorted the scan finds an
 * exact match first when there is one.
 */
export function initialMonthIndex(monthKeys: readonly string[], todayISO: string): number {
  if (monthKeys.length === 0) return 0;
  const today = monthKeyOf(todayISO);
  const next = monthKeys.findIndex((key) => key >= today);
  // Nothing at or after today: everything loaded is behind us, so open on the
  // last month there is.
  return next >= 0 ? next : monthKeys.length - 1;
}

/**
 * Is this night still worth showing under "Upcoming"?
 *
 * STATUS ALONE CANNOT ANSWER THIS. Closing a session is a manual admin action
 * with no cron behind it, so a night nobody remembered to close stays 'open'
 * for ever — which is how a Tuesday two days gone came to sit at the top of a
 * list headed "Upcoming", above the words "3 sessions accepting check-ins",
 * when its check-in had shut at 22:00 that night.
 *
 * The clock decides instead: a night stays until its check-in window CLOSES.
 * Genuinely future nights are kept (their window has not closed, and usually
 * has not opened either — the card says "Opens at 9:30 AM"); tonight is kept
 * for as long as anyone can still check in; and a night drops the moment it
 * can no longer be acted on. A forgotten `status` can now only make a night
 * linger until its own end time rather than indefinitely.
 *
 * Takes `closesAt` rather than computing it so the caller uses the same
 * settings-aware window as every other check-in decision on the page.
 */
export function isStillUpcoming(closesAt: Date, now: Date): boolean {
  return now < closesAt;
}
