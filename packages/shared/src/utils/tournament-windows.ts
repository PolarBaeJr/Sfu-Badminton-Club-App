import { clubWallClockToUtc, formatClubEventTime } from './club-events';
import { ExpectedError } from './expected-error';

/**
 * Registration and check-in windows (00276).
 *
 * A window is two optional instants on a tournament and on each of its events.
 * The event's own value wins and the tournament's fills a bound the event left
 * blank, one bound at a time. The window is a GATE on top of the event status,
 * never a replacement for it: an exec still opens check-in by hand, and outside
 * the window only the member's own entry and check-in are refused.
 */
export type WindowState = 'not_open_yet' | 'open' | 'closed';

export interface EntryWindow {
  opens_at: string | null;
  closes_at: string | null;
}

/** The four window columns, as both tables carry them. */
export interface WindowColumns {
  registration_opens_at?: string | null;
  registration_closes_at?: string | null;
  checkin_opens_at?: string | null;
  checkin_closes_at?: string | null;
}

/**
 * Where `now` falls in a window. The exact twin of public.entry_window_state:
 * open from `opens` inclusive, closed from `closes` inclusive, and a bound left
 * null never refuses.
 */
export function windowState(opens: string | null | undefined, closes: string | null | undefined, now: Date): WindowState {
  const at = now.getTime();
  if (opens && at < new Date(opens).getTime()) return 'not_open_yet';
  if (closes && at >= new Date(closes).getTime()) return 'closed';
  return 'open';
}

/**
 * The cases the SQL proof in 00276 runs, row for row. Read back by
 * tournament-windows-migration.test.ts, so editing one side alone fails.
 */
export const WINDOW_STATE_CASES: ReadonlyArray<{
  opens: string | null;
  closes: string | null;
  now: string;
  expected: WindowState;
}> = [
  { opens: null, closes: null, now: '2026-10-01T12:00:00Z', expected: 'open' },
  { opens: '2026-10-01T12:00:00Z', closes: null, now: '2026-10-01T11:59:59Z', expected: 'not_open_yet' },
  { opens: '2026-10-01T12:00:00Z', closes: null, now: '2026-10-01T12:00:00Z', expected: 'open' },
  { opens: null, closes: '2026-10-02T12:00:00Z', now: '2026-10-02T11:59:59Z', expected: 'open' },
  { opens: null, closes: '2026-10-02T12:00:00Z', now: '2026-10-02T12:00:00Z', expected: 'closed' },
  { opens: '2026-10-01T12:00:00Z', closes: '2026-10-02T12:00:00Z', now: '2026-09-30T00:00:00Z', expected: 'not_open_yet' },
  { opens: '2026-10-01T12:00:00Z', closes: '2026-10-02T12:00:00Z', now: '2026-10-01T18:00:00Z', expected: 'open' },
  { opens: '2026-10-01T12:00:00Z', closes: '2026-10-02T12:00:00Z', now: '2026-10-02T12:00:00Z', expected: 'closed' },
  { opens: '2026-10-01T12:00:00Z', closes: '2026-10-02T12:00:00Z', now: '2026-10-05T00:00:00Z', expected: 'closed' },
  { opens: '2026-11-01T08:00:00Z', closes: null, now: '2026-11-01T07:59:00Z', expected: 'not_open_yet' },
];

/**
 * The windows that apply to one event: each bound the event's own when set,
 * else the tournament's.
 */
export function effectiveWindows({
  event,
  tournament,
}: {
  event: WindowColumns | null | undefined;
  tournament: WindowColumns | null | undefined;
}): { registration: EntryWindow; checkin: EntryWindow } {
  const pick = (k: keyof WindowColumns) => event?.[k] ?? tournament?.[k] ?? null;
  return {
    registration: { opens_at: pick('registration_opens_at'), closes_at: pick('registration_closes_at') },
    checkin: { opens_at: pick('checkin_opens_at'), closes_at: pick('checkin_closes_at') },
  };
}

/**
 * A refusal sentence when a window closes at or before it opens, else null.
 * Both 00276 CHECKs say the same thing per row; this one is also asked of the
 * EFFECTIVE pair, which no CHECK can see.
 */
export function validateWindowPair(window: EntryWindow, label: string): string | null {
  if (!window.opens_at || !window.closes_at) return null;
  if (new Date(window.closes_at).getTime() <= new Date(window.opens_at).getTime()) {
    return `${label} must close after it opens.`;
  }
  return null;
}

/** Both pairs of one event's effective windows, the first refusal or null. */
export function validateEffectiveWindows(windows: { registration: EntryWindow; checkin: EntryWindow }): string | null {
  return validateWindowPair(windows.registration, 'Registration') ?? validateWindowPair(windows.checkin, 'Check-in');
}

export const WINDOW_COLUMN_KEYS = [
  'registration_opens_at',
  'registration_closes_at',
  'checkin_opens_at',
  'checkin_closes_at',
] as const satisfies ReadonlyArray<keyof WindowColumns>;

/**
 * Club wall-clock form values ("2026-10-01T09:00") as the instants the window
 * columns store. Only the keys given come back, so an undefined key leaves its
 * column alone; blank is null, which clears it (and inherits the tournament's,
 * for an event). A value that is not a real club time is refused.
 */
export function windowColumnsFromWallClock(
  input: Partial<Record<keyof WindowColumns, string | null | undefined>>,
): WindowColumns {
  const out: WindowColumns = {};
  for (const key of WINDOW_COLUMN_KEYS) {
    const value = input[key];
    if (value === undefined) continue;
    const raw = value?.trim() ?? '';
    if (raw === '') {
      out[key] = null;
      continue;
    }
    const at = clubWallClockToUtc(raw);
    if (!at) throw new ExpectedError(`Not a real date and time: ${raw}`);
    out[key] = at.toISOString();
  }
  return out;
}

/** A window bound for display, always in club time. */
export const formatWindowInstant = formatClubEventTime;

/**
 * What a member reads instead of the Register button, or null while the
 * registration window is open.
 */
export function registrationWindowNotice(window: EntryWindow, now: Date): string | null {
  const state = windowState(window.opens_at, window.closes_at, now);
  if (state === 'not_open_yet') return `Registration opens ${formatWindowInstant(window.opens_at!)}`;
  if (state === 'closed') return 'Registration closed';
  return null;
}

/**
 * What a member reads instead of the Check In button, or null while the
 * check-in window is open.
 */
export function checkinWindowNotice(window: EntryWindow, now: Date): string | null {
  const state = windowState(window.opens_at, window.closes_at, now);
  if (state === 'not_open_yet') return `Check-in opens ${formatWindowInstant(window.opens_at!)}`;
  if (state === 'closed') return 'Check-in has closed, see the desk';
  return null;
}
