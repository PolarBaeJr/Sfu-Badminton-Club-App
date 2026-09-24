// CLUB EVENTS THAT ARE NOT TOURNAMENTS: socials, workshops, clinics, outings
// and the AGM (00244). Pure helpers shared by the console and the members' app.
import { CLUB_TIMEZONE } from './constants';
import { CLUB_PERMANENT_OFFSET_FROM, wallClockToUtc } from './session-window';

export const CLUB_EVENT_KINDS = ['social', 'workshop', 'clinic', 'outing', 'agm', 'other'] as const;

export type ClubEventKind = (typeof CLUB_EVENT_KINDS)[number];

export const CLUB_EVENT_KIND_LABELS: Record<ClubEventKind, string> = {
  social: 'Social',
  workshop: 'Workshop',
  clinic: 'Clinic',
  outing: 'Outing',
  agm: 'AGM',
  other: 'Other',
};

export type ClubEventStatus = 'draft' | 'published' | 'cancelled';

// How far back the past list reaches. Nothing reads further than this.
export const PAST_CLUB_EVENTS_SHOWN = 50;

// How long an event with no end time is taken to run: the ICS DTEND and the
// feed's "has it finished yet" both read this.
export const CLUB_EVENT_DEFAULT_DURATION_MINUTES = 120;

/** Upcoming soonest first; past most recent first, capped. */
export function partitionClubEvents<T extends { starts_at: string }>(
  events: readonly T[],
  now: Date,
): { upcoming: T[]; past: T[] } {
  const at = now.getTime();
  const upcoming = events
    .filter((e) => new Date(e.starts_at).getTime() >= at)
    .sort((a, b) => new Date(a.starts_at).getTime() - new Date(b.starts_at).getTime());
  const past = events
    .filter((e) => new Date(e.starts_at).getTime() < at)
    .sort((a, b) => new Date(b.starts_at).getTime() - new Date(a.starts_at).getTime())
    .slice(0, PAST_CLUB_EVENTS_SHOWN);
  return { upcoming, past };
}

export type ClubEventSignupState =
  | 'going'
  | 'open'
  | 'full'
  | 'not_open_yet'
  | 'closed'
  | 'started'
  | 'cancelled';

export interface ClubEventTiming {
  status: string;
  starts_at: string;
  capacity: number | null;
  signup_opens_at: string | null;
  signup_closes_at: string | null;
}

/**
 * What the sign-up button should offer. IN THE ORDER club_event_sign_up and
 * club_event_withdraw decide, so the button never offers what the server
 * refuses: withdrawing ignores the sign-up close time but not the start, so a
 * member already signed up reads `going` after sign-ups close and `started`
 * once the event begins.
 */
export function clubEventSignupState(
  event: ClubEventTiming,
  now: Date,
  takenCount: number,
  mine: boolean,
): ClubEventSignupState {
  const at = now.getTime();
  if (event.status === 'cancelled') return 'cancelled';
  if (new Date(event.starts_at).getTime() <= at) return 'started';
  if (mine) return 'going';
  if (event.status !== 'published') return 'closed';
  if (event.signup_opens_at && at < new Date(event.signup_opens_at).getTime()) return 'not_open_yet';
  if (event.signup_closes_at && at >= new Date(event.signup_closes_at).getTime()) return 'closed';
  if (event.capacity !== null && takenCount >= event.capacity) return 'full';
  return 'open';
}

/** Display only: nothing charges for a club event. */
export function formatClubEventCost(cents: number | null): string | null {
  if (cents === null) return null;
  if (cents === 0) return 'Free';
  return `$${(cents / 100).toFixed(2)}`;
}

/** The shape a `datetime-local` input posts: `YYYY-MM-DDTHH:MM`. */
export const CLUB_WALL_CLOCK_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/;

/**
 * A club wall-clock string as a UTC instant, or null when it is not a real
 * time. Through wallClockToUtc and never `new Date(value)`: the server has no
 * timezone set, and BC drops the winter fallback on 2026-11-01, which tzdata on
 * the host may not know.
 */
export function clubWallClockToUtc(value: string): Date | null {
  const m = CLUB_WALL_CLOCK_PATTERN.exec(value);
  if (!m) return null;
  const [year, month, day, hour, minute] = m.slice(1).map(Number) as [number, number, number, number, number];
  if (month < 1 || month > 12 || hour > 23 || minute > 59) return null;
  // Rejects 2026-02-31, which Date.UTC would quietly roll into March.
  const probe = new Date(Date.UTC(year, month - 1, day));
  if (probe.getUTCDate() !== day || probe.getUTCMonth() !== month - 1) return null;
  return wallClockToUtc(year, month, day, hour, minute);
}

const CLUB_PERMANENT_OFFSET_MS = -7 * 60 * 60_000;

/**
 * A stored instant as the club wall-clock string an edit form starts from. The
 * same two-era rule as clubToday: past the cutover the offset is a constant and
 * no timezone data is read.
 */
export function utcToClubWallClock(iso: string): string {
  const at = new Date(iso);
  const pinned = new Date(at.getTime() + CLUB_PERMANENT_OFFSET_MS).toISOString();
  if (pinned.slice(0, 10) >= CLUB_PERMANENT_OFFSET_FROM) return pinned.slice(0, 16);
  const parts: Record<string, string> = {};
  for (const p of new Intl.DateTimeFormat('en-CA', {
    timeZone: CLUB_TIMEZONE,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).formatToParts(at)) {
    parts[p.type] = p.value;
  }
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
}

/**
 * The club date and time a stored instant falls on, e.g. `{ date: '2026-11-02',
 * time: '00:30' }`. The only way a club event is placed on a calendar day: never
 * the `Date` parts of the instant (the host's timezone) and never Intl alone
 * (tzdata on the host may predate 2026-11-01).
 */
export function clubEventWallClock(iso: string): { date: string; time: string } {
  const wall = utcToClubWallClock(iso);
  return { date: wall.slice(0, 10), time: wall.slice(11, 16) };
}

/**
 * A stored instant as club time for display, e.g. "Nov 4, 2026, 7:00 PM".
 * The same options as formatDateTime, but read through utcToClubWallClock, so
 * a time on or after 2026-11-01 is right on a host whose tzdata predates the
 * BC change. formatDateTime asks Intl for Vancouver and would be an hour off.
 */
export function formatClubEventTime(iso: string): string {
  const m = CLUB_WALL_CLOCK_PATTERN.exec(utcToClubWallClock(iso));
  if (!m) return iso;
  const [year, month, day, hour, minute] = m.slice(1).map(Number) as [number, number, number, number, number];
  return new Date(Date.UTC(year, month - 1, day, hour, minute)).toLocaleString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZone: 'UTC',
  });
}
