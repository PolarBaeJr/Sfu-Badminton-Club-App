import { clubToday } from '@badminton/shared';

/**
 * THE CLUB'S WEEK, AS THREE `YYYY-MM-DD` STRINGS.
 *
 * The dashboard counts "sessions this week" and "who joined this week", and
 * both boundaries have to be club-local. `new Date().toISOString()` is UTC and
 * Vancouver is UTC-7/-8, so from ~17:00 on a Sunday the UTC clock has already
 * rolled into Monday and the week the officer is standing in is not the week
 * the query would ask for.
 *
 * NOT A THIRD TIMEZONE HELPER. `clubToday()` in @badminton/shared is the one
 * place that knows what day it is in the club's timezone, and this module does
 * nothing but calendar arithmetic on the string it returns. That distinction is
 * the entire design: once the day is a club-local `YYYY-MM-DD`, adding days is
 * pure calendar work with no zone in it, and `sessions.date` is a Postgres DATE
 * column so the comparison downstream is string-to-string. Re-entering a
 * timezone here — `new Date(clubToday())` and back out through Intl — is
 * exactly how the DST bug that measured a 98-day term as 15 weeks happened.
 *
 * `Date.UTC` is used purely as a calendar calculator: it normalises day
 * overflow (Feb 30 → Mar 2, Dec 32 → Jan 1) and it gives a weekday, and because
 * both the input and the output are UTC midnights there is no offset to get
 * wrong.
 */

/** Shift a `YYYY-MM-DD` calendar date by whole days. */
export function addCalendarDays(date: string, days: number): string {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

/**
 * The Monday of the week containing `date`.
 *
 * Monday rather than Sunday because the club's term is read in weeks that start
 * with the working week, and because the sessions page already presents a term
 * that way.
 */
export function clubWeekStart(date: string): string {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  const dayOfWeek = new Date(Date.UTC(y, m - 1, d)).getUTCDay(); // 0 = Sunday
  return addCalendarDays(date, dayOfWeek === 0 ? -6 : 1 - dayOfWeek);
}

export interface ClubWeek {
  /** Today, club-local. */
  today: string;
  /** Monday of this club week, inclusive. */
  start: string;
  /** Sunday of this club week, inclusive. */
  end: string;
}

export function clubWeek(now: Date = new Date()): ClubWeek {
  const today = clubToday(now);
  const start = clubWeekStart(today);
  return { today, start, end: addCalendarDays(start, 6) };
}
