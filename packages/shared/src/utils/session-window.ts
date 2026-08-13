// Client/server mirror of the DB function session_checkin_open
// (00008_richer_attendance.sql, rewritten in 00110_session_instants.sql). The
// DB function is the enforcement source of truth (RLS backstop); this exists
// so apps can show friendly window state without a round trip. All session
// wall-clock times are club-local (CLUB_TIMEZONE).
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
  // The instants the database resolved at write time (00110). Optional
  // because most callers select only the wall clock; when they ARE present
  // they win, so what the UI shows is what the RLS gate will actually
  // enforce rather than a re-derivation that could disagree.
  //
  // ends_at is null-but-meaningful: null means "start_time set, end_time
  // not", the branch that closes at start + the runtime duration setting.
  // undefined means the caller did not select the column at all.
  starts_at?: string | null;
  ends_at?: string | null;
}

/**
 * The date from which club time stops depending on the IANA timezone
 * database, and the offset it is pinned to.
 *
 * tzdata 2026b removed British Columbia's autumn fall-back: from
 * 2026-11-01 America/Vancouver is UTC-07:00 and never changes again.
 * Verified under node:24-alpine (tzdata 2026b) that Vancouver is
 * GMT-07:00 on 2026-11-01, 2027-01-15, 2027-06-15, 2028-01-15 and
 * 2030-01-15 — permanent, not one skipped winter.
 *
 * Older tzdata still says UTC-08:00 for those winter dates, and "older"
 * covers most of what this code runs on: production is Node 20 (tzdata
 * 2025c) and even a Node 26 built before the release carries 2026a.
 * Reading `process.versions.tz` is the only way to tell, and no build
 * step checks it — so rather than depend on the host being new enough,
 * this module refuses to consult tzdata for these dates at all.
 *
 * The same two-branch rule is implemented in SQL as club_local_instant()
 * (00110_session_instants.sql), and both are pinned to the same checked-in
 * fixtures in club-time.test.ts, generated once under tzdata 2026b.
 *
 * 2026-11-01 works as a whole-day boundary because 2026b puts no
 * transition on that day — under the new rule the day is UTC-07:00
 * throughout, and under the old rule it began at UTC-07:00 too, so
 * midnight resolves identically either way.
 */
export const CLUB_PERMANENT_OFFSET_FROM = '2026-11-01';
const CLUB_PERMANENT_OFFSET_MS = -7 * 60 * 60_000;

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

// Convert a club-local wall-clock time to a UTC instant.
//
// On or after CLUB_PERMANENT_OFFSET_FROM the offset is a constant and no
// timezone data is read, which is what makes this correct on Node 20 as well
// as Node 24. Before that date every tzdata release ever shipped agrees about
// Vancouver, so the standard two-pass Intl technique is used: guess the offset
// at the naive-UTC reading of the wall clock, then re-derive it at the
// corrected instant.
//
// DST edges, for the historical branch only (there are none left in club time
// after the pin, so this is now a statement about the past): an ambiguous
// wall clock — 01:30 on a fall-back day, which happens twice — resolves to the
// FIRST occurrence, i.e. the daylight-time one. A wall clock inside the
// spring-forward gap — 02:30 on 2026-03-08, which never happens — resolves to
// the instant one hour before the gap. Both are the two-pass technique's own
// tie-breaks and both are unchanged from before; note that they are NOT the
// same tie-breaks Postgres makes (measured: PG picks the second occurrence for
// the ambiguous hour and shifts forward out of the gap). That divergence
// predates this change, and preferring the stored starts_at/ends_at in
// getCheckinWindow is what removes it from anywhere it could matter.
export function wallClockToUtc(year: number, month: number, day: number, hour: number, minute: number): Date {
  const naiveUtc = Date.UTC(year, month - 1, day, hour, minute);
  // Via the normalized date, because callers legitimately pass day overflow
  // (day + 1 for the next-day-midnight bound) and Date.UTC rolls it.
  const clubDate = new Date(naiveUtc).toISOString().slice(0, 10);
  if (clubDate >= CLUB_PERMANENT_OFFSET_FROM) {
    return new Date(naiveUtc - CLUB_PERMANENT_OFFSET_MS);
  }
  const offset1 = tzOffsetMs(naiveUtc);
  const offset2 = tzOffsetMs(naiveUtc - offset1);
  return new Date(naiveUtc - offset2);
}

function parseTime(time: string): { hour: number; minute: number } {
  const [h, m] = time.split(':');
  return { hour: Number(h), minute: Number(m ?? '0') };
}

// The two tunables session_checkin_open() reads out of the
// platform_settings 'session_attendance' row on every call.
export interface CheckinSettings {
  defaultDurationMinutes: number;
  opensMinutesBefore: number | null;
}

// Fallback for callers that cannot reach the database — client components and
// pure formatters. These track the values currently applied on prod, but they
// are a guess: platform_settings is admin-editable, so anything rendered from
// this fallback can disagree with what the RLS gate will actually allow.
// SERVER CALLERS SHOULD FETCH AND PASS THE REAL ROW (parseCheckinSettings).
export const FALLBACK_CHECKIN_SETTINGS: CheckinSettings = {
  defaultDurationMinutes: SESSION_DEFAULT_DURATION_MINUTES,
  opensMinutesBefore: SESSION_CHECKIN_OPENS_MINUTES_BEFORE,
};

// Parse a platform_settings 'session_attendance' value into CheckinSettings,
// reproducing session_checkin_open()'s own coercion exactly
// (00008_richer_attendance.sql:56-58):
//   - default_duration_minutes falls back to 120 when absent/unparseable,
//     because the SQL wraps it in COALESCE(..., 120)
//   - checkin_opens_minutes_before yields NULL when absent, and the SQL
//     treats NULL as "no opening edge"
// Note the deliberate asymmetry with FALLBACK_CHECKIN_SETTINGS above: this
// mirrors what the DATABASE does with a missing key, which is not the same as
// what prod is currently configured to.
export function parseCheckinSettings(value: unknown): CheckinSettings {
  const row = (value ?? {}) as Record<string, unknown>;
  const duration = Number(row.default_duration_minutes);
  const opens = Number(row.checkin_opens_minutes_before);
  return {
    defaultDurationMinutes: Number.isFinite(duration) ? duration : 120,
    opensMinutesBefore:
      row.checkin_opens_minutes_before == null || !Number.isFinite(opens) ? null : opens,
  };
}

// Same rules as session_checkin_open: close at date + end_time if set, else
// start_time + default duration if start_time is set, else end of the
// session's date (start of the next day, club time). opensAt is null when
// opensMinutesBefore is null (no opening edge).
//
// Both edges stay derived rather than read from a column even now that the
// instants are stored, and for the same reason the database leaves them
// derived: checkin_opens_minutes_before and default_duration_minutes live in
// platform_settings and an admin can retune them at any time. Precomputing
// the opening edge would mean an admin who widened the window found it had
// no effect on any session already created. Store the instant, keep the
// offsets runtime.
export function getCheckinWindow(
  session: SessionWindowFields,
  settings: CheckinSettings = FALLBACK_CHECKIN_SETTINGS
): {
  opensAt: Date | null;
  closesAt: Date;
} {
  const startAt = resolveStart(session);

  let closesAt: Date;
  if (session.starts_at) {
    // Stored instants (00110). ends_at null is the duration branch — the DB
    // leaves it null precisely when start_time is set and end_time is not.
    closesAt = session.ends_at
      ? new Date(session.ends_at)
      : new Date(startAt.getTime() + settings.defaultDurationMinutes * 60_000);
  } else {
    const [y, mo, d] = session.date.split('-').map(Number) as [number, number, number];
    if (session.end_time) {
      const end = parseTime(session.end_time);
      closesAt = wallClockToUtc(y, mo, d, end.hour, end.minute);
    } else if (session.start_time) {
      closesAt = new Date(startAt.getTime() + settings.defaultDurationMinutes * 60_000);
    } else {
      // Date.UTC normalizes day overflow, so d + 1 rolls month/year correctly.
      closesAt = wallClockToUtc(y, mo, d + 1, 0, 0);
    }
  }

  const opensAt =
    settings.opensMinutesBefore == null
      ? null
      : new Date(startAt.getTime() - settings.opensMinutesBefore * 60_000);

  return { opensAt, closesAt };
}

// The session's start instant: the one the database resolved if the caller
// selected it, otherwise re-derived from the wall clock. The two agree by
// construction — club_local_instant() and wallClockToUtc() implement the same
// rule against the same fixtures — with one exception worth preferring the
// stored value for: the ambiguous hour of a historical fall-back day, where
// Postgres and the Intl two-pass break the tie differently.
function resolveStart(session: SessionWindowFields): Date {
  if (session.starts_at) return new Date(session.starts_at);
  const [y, mo, d] = session.date.split('-').map(Number) as [number, number, number];
  const start = parseTime(session.start_time ?? '00:00');
  return wallClockToUtc(y, mo, d, start.hour, start.minute);
}

export function isCheckinOpen(
  session: SessionWindowFields,
  now: Date = new Date(),
  settings: CheckinSettings = FALLBACK_CHECKIN_SETTINGS
): boolean {
  if (session.status !== undefined && session.status !== 'open') return false;
  const { opensAt, closesAt } = getCheckinWindow(session, settings);
  if (opensAt && now < opensAt) return false;
  return now < closesAt;
}

/**
 * Today's date in the club's timezone, as YYYY-MM-DD.
 *
 * `new Date().toISOString().split('T')[0]` gives the UTC date, and Vancouver is
 * UTC-7/-8. Any club evening after 17:00 PDT (16:00 PST) is already tomorrow in
 * UTC, so stamping a DATE column that way records the wrong day — an exec
 * ending a season on Friday evening recorded it as ending Saturday.
 *
 * en-CA formats as YYYY-MM-DD, which is exactly the shape a Postgres DATE
 * column and every YYYY-MM-DD string comparison in this codebase expect.
 */
export function clubToday(now: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: CLUB_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}
