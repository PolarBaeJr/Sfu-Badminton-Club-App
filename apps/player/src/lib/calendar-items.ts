// Pure derivations behind the schedule on /feed: the month grid, the week
// strip and the "Up next" agenda, with sessions, club events and tournaments in
// one list.
//
// Same rule as ./schedule: nothing here reads the clock. The page takes one
// `now` and one pinned club-local `todayISO` per render and passes them in, so
// every date on the screen comes from the same reading and the tests can fix it.

import {
  CLUB_EVENT_DEFAULT_DURATION_MINUTES,
  clubEventWallClock,
  formatTime,
  getCheckinWindow,
  type CheckinSettings,
  type SessionWindowFields,
} from '@badminton/shared';
import { CALENDAR_WEEKDAYS, addDaysISO, groupSessionsByDay, isStillUpcoming, type DayGroup } from './schedule';

export type CalendarTone = 'open' | 'closed' | 'club' | 'tournament' | 'cancelled';

export type CalendarItemKind = 'session' | 'club_event' | 'tournament';

/** One entry on the month grid or the week strip. Every string on it is
 *  formatted on the server, so the client grid does no date maths. */
export interface CalendarItem {
  /** Unique across kinds, and per day for a tournament that spans several. */
  key: string;
  id: string;
  kind: CalendarItemKind;
  /** Club-local YYYY-MM-DD. */
  date: string;
  /** Tournaments run all day and sort ahead of anything with a time. */
  allDay: boolean;
  /** Club-local 'HH:MM', or null for no time. */
  sortTime: string | null;
  name: string;
  /** "6:30 PM", or null. */
  timeLabel: string | null;
  tone: CalendarTone;
  /** This member is going, checked in, attended or signed up. */
  mine: boolean;
  /** '#session-<id>' for a card on the page, a route, or null for plain text. */
  href: string | null;
}

export interface CalendarSessionRow {
  id: string;
  name: string | null;
  date: string;
  start_time: string | null;
  status: string;
}

export interface CalendarClubEventRow {
  id: string;
  title: string;
  kind: string;
  location: string | null;
  starts_at: string;
  ends_at: string | null;
  status: string;
}

export interface CalendarTournamentRow {
  id: string;
  name: string;
  start_date: string;
  end_date: string | null;
  status: string;
  suspended_at: string | null;
}

export function sessionCalendarItem(
  s: CalendarSessionRow,
  opts: { mine: boolean; hasCard: boolean },
): CalendarItem {
  const sortTime = s.start_time ? s.start_time.slice(0, 5) : null;
  return {
    key: `session:${s.id}`,
    id: s.id,
    kind: 'session',
    date: s.date,
    allDay: false,
    sortTime,
    name: s.name ?? 'Practice Session',
    timeLabel: s.start_time ? formatTime(s.start_time) : null,
    tone: s.status === 'open' ? 'open' : 'closed',
    mine: opts.mine,
    href: opts.hasCard ? `#session-${s.id}` : null,
  };
}

export function clubEventCalendarItem(e: CalendarClubEventRow, opts: { mine: boolean }): CalendarItem {
  const { date, time } = clubEventWallClock(e.starts_at);
  return {
    key: `club_event:${e.id}`,
    id: e.id,
    kind: 'club_event',
    date,
    allDay: false,
    sortTime: time,
    name: e.title,
    timeLabel: formatTime(time),
    tone: e.status === 'cancelled' ? 'cancelled' : 'club',
    mine: opts.mine,
    href: `/events/${e.id}`,
  };
}

/**
 * One item per day the tournament runs, capped so a typo in `end_date` cannot
 * paint a month. Says nothing about whether this member is entered: entry
 * status is not read here, so `mine` is always false.
 */
export function tournamentCalendarItems(
  t: CalendarTournamentRow,
  opts: { maxDays?: number } = {},
): CalendarItem[] {
  const maxDays = opts.maxDays ?? 7;
  const last = t.end_date && t.end_date > t.start_date ? t.end_date : t.start_date;
  const items: CalendarItem[] = [];
  for (let date = t.start_date; date <= last && items.length < maxDays; date = addDaysISO(date, 1)) {
    items.push({
      key: `tournament:${t.id}:${date}`,
      id: t.id,
      kind: 'tournament',
      date,
      allDay: true,
      sortTime: null,
      name: t.name,
      timeLabel: null,
      tone: 'tournament',
      mine: false,
      href: `/tournaments/${t.id}`,
    });
  }
  return items;
}

type Orderable = { date: string; allDay: boolean; sortTime: string | null; name: string };

/** By date, then all-day first, then by time with untimed last, then by name. */
export function compareCalendarItems(a: Orderable, b: Orderable): number {
  if (a.date !== b.date) return a.date < b.date ? -1 : 1;
  if (a.allDay !== b.allDay) return a.allDay ? -1 : 1;
  if (a.sortTime !== b.sortTime) {
    if (a.sortTime === null) return 1;
    if (b.sortTime === null) return -1;
    return a.sortTime < b.sortTime ? -1 : 1;
  }
  return a.name.localeCompare(b.name);
}

export interface WeekStripDay {
  dateISO: string;
  /** "Tue". */
  weekday: string;
  /** Day of the month. */
  day: number;
  isToday: boolean;
  /** Up to three, in day order. */
  marks: CalendarTone[];
  /** How many items are not shown as a mark. */
  more: number;
  /** The whole day in words, for a screen reader: "Tue 14: 1 session, 1 club event". */
  summary: string;
  count: number;
}

const WEEK_MARKS = 3;

const KIND_WORDS: Record<CalendarItemKind, [string, string]> = {
  session: ['session', 'sessions'],
  club_event: ['club event', 'club events'],
  tournament: ['tournament', 'tournaments'],
};

/** The seven days from today, each with its items as colour marks. */
export function buildWeekStrip(items: readonly CalendarItem[], todayISO: string, days = 7): WeekStripDay[] {
  const out: WeekStripDay[] = [];
  for (let i = 0; i < days; i += 1) {
    const dateISO = addDaysISO(todayISO, i);
    const dayItems = items.filter((it) => it.date === dateISO).sort(compareCalendarItems);
    const [y, m, d] = dateISO.split('-').map(Number) as [number, number, number];
    const weekday = CALENDAR_WEEKDAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()] ?? '';
    const counts = (Object.keys(KIND_WORDS) as CalendarItemKind[])
      .map((kind) => {
        const n = dayItems.filter((it) => it.kind === kind).length;
        const [one, many] = KIND_WORDS[kind];
        return n > 0 ? `${n} ${n === 1 ? one : many}` : null;
      })
      .filter(Boolean);
    out.push({
      dateISO,
      weekday,
      day: d,
      isToday: i === 0,
      marks: dayItems.slice(0, WEEK_MARKS).map((it) => it.tone),
      more: Math.max(dayItems.length - WEEK_MARKS, 0),
      summary: `${weekday} ${d}: ${counts.length > 0 ? counts.join(', ') : 'nothing on'}`,
      count: dayItems.length,
    });
  }
  return out;
}

// ── THE AGENDA ────────────────────────────────────────────────────────────

type AgendaBase = { key: string; date: string; allDay: boolean; sortTime: string | null; name: string };

export type AgendaEntry<S, E, T> =
  | (AgendaBase & { kind: 'session'; session: S })
  | (AgendaBase & { kind: 'club_event'; event: E })
  | (AgendaBase & { kind: 'tournament'; tournament: T });

export type AgendaSession = SessionWindowFields & { id: string; name: string | null; date: string };

/** The instant a club event is over: its end, or start plus the default length. */
export function clubEventEndsAt(e: { starts_at: string; ends_at: string | null }): Date {
  return e.ends_at
    ? new Date(e.ends_at)
    : new Date(new Date(e.starts_at).getTime() + CLUB_EVENT_DEFAULT_DURATION_MINUTES * 60_000);
}

/**
 * What is coming up, grouped by club day:
 *  - open sessions until their check-in window closes, the rule /sessions has
 *    always used (see isStillUpcoming);
 *  - club events until they are over, cancelled ones included, so a
 *    cancellation stays visible until the slot passes; the soonest few only;
 *  - running-season tournaments not yet finished, not suspended, and not
 *    already shown as a live banner, placed on today once they have started.
 */
export function buildAgenda<
  S extends AgendaSession,
  E extends CalendarClubEventRow,
  T extends CalendarTournamentRow,
>(input: {
  sessions: readonly S[];
  clubEvents: readonly E[];
  tournaments: readonly T[];
  now: Date;
  todayISO: string;
  checkinSettings: CheckinSettings;
  liveTournamentIds: ReadonlySet<string>;
  clubEventsCap?: number;
}): DayGroup<AgendaEntry<S, E, T>>[] {
  const { now, todayISO } = input;
  const entries: AgendaEntry<S, E, T>[] = [];

  for (const s of input.sessions) {
    if (!isStillUpcoming(getCheckinWindow(s, input.checkinSettings).closesAt, now)) continue;
    entries.push({
      kind: 'session',
      key: `session:${s.id}`,
      date: s.date,
      allDay: false,
      sortTime: s.start_time ? s.start_time.slice(0, 5) : null,
      name: s.name ?? 'Practice Session',
      session: s,
    });
  }

  const events = input.clubEvents
    .filter((e) => clubEventEndsAt(e) > now)
    .sort((a, b) => new Date(a.starts_at).getTime() - new Date(b.starts_at).getTime())
    .slice(0, input.clubEventsCap ?? 10);
  for (const e of events) {
    const { date, time } = clubEventWallClock(e.starts_at);
    entries.push({ kind: 'club_event', key: `club_event:${e.id}`, date, allDay: false, sortTime: time, name: e.title, event: e });
  }

  for (const t of input.tournaments) {
    if (t.status !== 'active' || t.suspended_at !== null || input.liveTournamentIds.has(t.id)) continue;
    const last = t.end_date && t.end_date > t.start_date ? t.end_date : t.start_date;
    if (last < todayISO) continue;
    const date = t.start_date > todayISO ? t.start_date : todayISO;
    entries.push({ kind: 'tournament', key: `tournament:${t.id}`, date, allDay: true, sortTime: null, name: t.name, tournament: t });
  }

  entries.sort(compareCalendarItems);
  return groupSessionsByDay(entries, todayISO);
}
