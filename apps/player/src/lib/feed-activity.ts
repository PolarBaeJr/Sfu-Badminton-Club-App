// Derivations behind the /feed activity river and its header.
//
// Lives in apps/player rather than packages/shared: these are the shapes this
// one screen needs, and the brief for it forbids touching the shared packages.
//
// Everything here is pure and takes `now` as an argument rather than reading
// the clock, so "today" can be tested rather than hoped for.

/** The club runs on one wall clock; a match played at 23:30 in Vancouver is
 *  not yesterday's match because the server happened to be on UTC. Every day
 *  boundary in this file is a CLUB day boundary. */
export function clubDayKey(iso: string, timeZone: string): string {
  // en-CA renders as YYYY-MM-DD, which is both what we want to display-group by
  // and what sorts correctly as a plain string.
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(iso));
}

/** Shifts a YYYY-MM-DD key by whole days without going through a Date in the
 *  local zone — the key is already club-local, so arithmetic on it must not
 *  reintroduce an offset. Noon UTC is used as the anchor so a ±14h zone shift
 *  can never move the result onto an adjacent day. */
export function shiftDayKey(key: string, days: number): string {
  const [y, m, d] = key.split('-').map(Number);
  const anchor = Date.UTC(y ?? 1970, (m ?? 1) - 1, d ?? 1, 12);
  return new Date(anchor + days * 86400000).toISOString().slice(0, 10);
}

/** "TODAY" / "YESTERDAY" / "WED 4 AUG". Uppercase because the mockup's section
 *  headers are mono micro-caps, and because a date that reads as a label rather
 *  than as content is easier to skip past. */
export function dayLabel(key: string, todayKey: string): string {
  if (key === todayKey) return 'TODAY';
  if (key === shiftDayKey(todayKey, -1)) return 'YESTERDAY';
  const [y, m, d] = key.split('-').map(Number);
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'UTC',
    weekday: 'short',
    day: 'numeric',
    month: 'short',
  })
    .format(new Date(Date.UTC(y ?? 1970, (m ?? 1) - 1, d ?? 1, 12)))
    .replace(',', '')
    .toUpperCase();
}

/**
 * How to name the day a session falls on.
 *
 * "Monday" alone is what the mockup shows and is right for the common case, and
 * wrong the moment the next session is more than a week out — "Monday" would
 * then mean a Monday nine days away and a member could turn up to an empty gym.
 * Inside a week the weekday is unambiguous; past that, date it.
 */
export function sessionDayLabel(dateKey: string, todayKey: string): string {
  const day = dateKey.slice(0, 10);
  if (day === todayKey) return 'Today';
  if (day === shiftDayKey(todayKey, 1)) return 'Tomorrow';

  const [y, m, d] = day.split('-').map(Number);
  const at = new Date(Date.UTC(y ?? 1970, (m ?? 1) - 1, d ?? 1, 12));
  const withinAWeek = day > todayKey && day <= shiftDayKey(todayKey, 6);

  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'UTC',
    weekday: 'long',
    ...(withinAWeek ? {} : { day: 'numeric', month: 'short' }),
  })
    .format(at)
    .replace(',', '');
}

export type DaySection<T> = { key: string; label: string; items: T[] };

/**
 * Groups already-sorted items into club days, newest day first, preserving the
 * order within each day. Sorting is done here too rather than assumed, because
 * the river merges two differently-ordered queries.
 */
export function groupByDay<T extends { at: string }>(
  items: T[],
  now: Date,
  timeZone: string,
): DaySection<T>[] {
  const todayKey = clubDayKey(now.toISOString(), timeZone);
  const sections = new Map<string, T[]>();

  for (const item of [...items].sort((a, b) => b.at.localeCompare(a.at))) {
    const key = clubDayKey(item.at, timeZone);
    const bucket = sections.get(key);
    if (bucket) bucket.push(item);
    else sections.set(key, [item]);
  }

  return [...sections.entries()]
    .sort((a, b) => b[0].localeCompare(a[0]))
    .map(([key, list]) => ({ key, label: dayLabel(key, todayKey), items: list }));
}

/**
 * Which week of the season we are in, 1-based and inclusive of the start day.
 *
 * There is no week column on `seasons` — this is derived from start_date, which
 * is the only honest source for it. Null before the season has begun, because
 * "week 0" is not a thing the club says.
 */
export function seasonWeek(startDate: string, now: Date, timeZone: string): number | null {
  const start = startDate.slice(0, 10);
  const today = clubDayKey(now.toISOString(), timeZone);
  if (today < start) return null;

  const toUtcNoon = (key: string) => {
    const [y, m, d] = key.split('-').map(Number);
    return Date.UTC(y ?? 1970, (m ?? 1) - 1, d ?? 1, 12);
  };
  const days = Math.floor((toUtcNoon(today) - toUtcNoon(start)) / 86400000);
  return Math.floor(days / 7) + 1;
}

/**
 * How many of the club's most recent sessions the member turned up to in a row.
 *
 * `pastSessionsNewestFirst` is the sessions this member was eligible for and
 * that have already happened; a streak counts down from the latest and stops at
 * the first one they missed. Sessions they were never eligible for are the
 * caller's job to exclude — being ineligible is not the same as not turning up.
 */
export function attendanceStreak(
  pastSessionsNewestFirst: { id: string }[],
  attendedIds: ReadonlySet<string>,
): number {
  let streak = 0;
  for (const session of pastSessionsNewestFirst) {
    if (!attendedIds.has(session.id)) break;
    streak++;
  }
  return streak;
}

export type RiverPerson = { id: string; name: string; handle: string | null; avatarUrl: string | null };

export type MatchSides = {
  winners: RiverPerson[];
  losers: RiverPerson[];
};

/**
 * The one-line sentence a match row leads with.
 *
 * Written from the reader's point of view: a match they played reads "You beat
 * Marcus Ng" or "Marcus Ng beat you", never "Kiera Watanabe beat Marcus Ng"
 * about themselves. Everyone else's matches read in the third person. Doubles
 * pairs are joined with "&" so the sentence stays one line at 360px.
 */
export function describeMatch(sides: MatchSides, viewerId: string): string | null {
  if (sides.winners.length === 0 || sides.losers.length === 0) return null;

  const iWon = sides.winners.some((p) => p.id === viewerId);
  const iLost = sides.losers.some((p) => p.id === viewerId);

  const nameList = (people: RiverPerson[], excludeViewer: boolean) => {
    const shown = excludeViewer ? people.filter((p) => p.id !== viewerId) : people;
    return shown.map((p) => p.name).join(' & ');
  };

  if (iWon) {
    // A doubles partner is dropped from the subject rather than rendered as
    // "You & Priya beat …": the row is the member's own, and their partner is
    // already visible in the avatars.
    return `You beat ${nameList(sides.losers, false)}`;
  }
  if (iLost) {
    return `${nameList(sides.winners, false)} beat you`;
  }
  return `${nameList(sides.winners, false)} beat ${nameList(sides.losers, false)}`;
}
