import { describe, expect, it } from 'vitest';
import {
  formatDayKey,
  formatSeasonRange,
  joinedAfterSeason,
  memberSeasonHistory,
  nextSeasonAfter,
  seasonEmptyReason,
  seasonPickerOptions,
  settledOutcome,
  summarizeSeason,
  type HistorySeason,
  type SeasonMatchRow,
} from '@/lib/season-history';

const season = (over: Partial<HistorySeason> & { id: string }): HistorySeason => ({
  name: over.id,
  start_date: '2026-09-01',
  end_date: '2026-12-31',
  active_flag: false,
  ...over,
});

const match = (over: Partial<SeasonMatchRow>): SeasonMatchRow => ({
  match_type: 'singles',
  result_status: 'confirmed',
  win_flag: true,
  points_scored: 21,
  points_allowed: 17,
  played_at: '2026-09-10T02:00:00Z',
  ...over,
});

describe('settledOutcome', () => {
  it('counts a confirmed win', () => {
    expect(settledOutcome(match({}))).toBe(true);
  });

  it('counts a walkover, which somebody really was awarded', () => {
    expect(settledOutcome(match({ result_status: 'walkover', win_flag: false }))).toBe(false);
  });

  it('refuses a voided match even though its win_flag survived the voiding', () => {
    // 00003 sets result_status = 'voided' and leaves win_flag alone. A tally
    // written on win_flag alone would keep counting a struck-off match.
    expect(settledOutcome(match({ result_status: 'voided', win_flag: true }))).toBeNull();
  });

  it('refuses a disputed match', () => {
    expect(settledOutcome(match({ result_status: 'disputed' }))).toBeNull();
  });

  it('refuses a confirmed row whose winner was never stamped', () => {
    expect(settledOutcome(match({ win_flag: null }))).toBeNull();
  });
});

describe('summarizeSeason', () => {
  it('splits the record by discipline and adds up to the total', () => {
    const r = summarizeSeason([
      match({ win_flag: true, match_type: 'singles' }),
      match({ win_flag: false, match_type: 'singles' }),
      match({ win_flag: true, match_type: 'doubles' }),
    ]);
    expect(r.singles).toEqual({ wins: 1, losses: 1 });
    expect(r.doubles).toEqual({ wins: 1, losses: 0 });
    expect(r.wins).toBe(2);
    expect(r.losses).toBe(1);
    expect(r.singles.wins + r.doubles.wins).toBe(r.wins);
    expect(r.played).toBe(3);
  });

  it('leaves unsettled rows out of played, not just out of the win column', () => {
    const r = summarizeSeason([
      match({ result_status: 'confirmed' }),
      match({ result_status: 'disputed' }),
      match({ result_status: 'pending_confirmation', win_flag: null }),
    ]);
    expect(r.played).toBe(1);
    expect(r.wins).toBe(1);
    expect(r.losses).toBe(0);
  });

  it('nets the point differential over settled matches only', () => {
    const r = summarizeSeason([
      match({ points_scored: 42, points_allowed: 30 }),
      match({ points_scored: 20, points_allowed: 42, win_flag: false }),
      match({ points_scored: 99, points_allowed: 0, result_status: 'voided' }),
    ]);
    expect(r.pointDiff).toBe(12 - 22);
  });

  it('finds the best win streak in date order, whatever order the rows arrive in', () => {
    const r = summarizeSeason([
      match({ played_at: '2026-10-01T02:00:00Z', win_flag: true }),
      match({ played_at: '2026-09-01T02:00:00Z', win_flag: true }),
      match({ played_at: '2026-09-15T02:00:00Z', win_flag: false }),
      match({ played_at: '2026-10-08T02:00:00Z', win_flag: true }),
      match({ played_at: '2026-10-15T02:00:00Z', win_flag: true }),
    ]);
    // Sorted: W L W W W -> best run is the last three, not the four wins in the
    // order they were handed over.
    expect(r.bestWinStreak).toBe(3);
  });

  it('does not let a voided match join two win streaks together', () => {
    const r = summarizeSeason([
      match({ played_at: '2026-09-01T02:00:00Z', win_flag: true }),
      match({ played_at: '2026-09-08T02:00:00Z', win_flag: false, result_status: 'voided' }),
      match({ played_at: '2026-09-15T02:00:00Z', win_flag: true }),
    ]);
    // The voided row is skipped rather than breaking the run, so the two wins
    // either side of it are one streak of two.
    expect(r.bestWinStreak).toBe(2);
  });

  it('counts an undated match toward the record but not toward the streak', () => {
    const r = summarizeSeason([match({ played_at: null, win_flag: true })]);
    expect(r.played).toBe(1);
    expect(r.bestWinStreak).toBe(0);
  });

  it('returns an empty record rather than throwing on no rows', () => {
    const r = summarizeSeason([]);
    expect(r).toEqual({
      singles: { wins: 0, losses: 0 },
      doubles: { wins: 0, losses: 0 },
      wins: 0,
      losses: 0,
      played: 0,
      pointDiff: 0,
      bestWinStreak: 0,
    });
  });
});

describe('memberSeasonHistory', () => {
  // The shape staging is actually in: today is 2026-08-11 and EVERY season,
  // including the active one, starts in the future. Any date-based idea of
  // "past" answers a question about the fixtures rather than about the club.
  const seasons = [
    season({ id: 'fall-2026', start_date: '2026-09-01', end_date: '2026-12-31', active_flag: true }),
    season({ id: 'spring-2027', start_date: '2027-01-01', end_date: '2027-04-30' }),
    season({ id: 'fall-2027', start_date: '2027-09-01', end_date: '2027-12-31' }),
    season({ id: 'summer-2027', start_date: '2029-08-15', end_date: null }),
  ];

  it('offers only inactive seasons the member has an archived rating for', () => {
    const out = memberSeasonHistory(seasons, new Set(['spring-2027']), null);
    expect(out.map((s) => s.id)).toEqual(['spring-2027']);
  });

  it('never offers the active season as history', () => {
    const out = memberSeasonHistory(seasons, new Set(['fall-2026', 'spring-2027']), null);
    expect(out.map((s) => s.id)).toEqual(['spring-2027']);
  });

  it('keeps a season nobody archived out of the list even though its dates look plausible', () => {
    expect(memberSeasonHistory(seasons, new Set(), null)).toEqual([]);
  });

  it('unions in a season somebody was linked to, so the control agrees with the page', () => {
    const out = memberSeasonHistory(seasons, new Set(['spring-2027']), 'fall-2027');
    expect(out.map((s) => s.id)).toEqual(['fall-2027', 'spring-2027']);
  });

  it('orders newest first by start date', () => {
    const out = memberSeasonHistory(
      seasons,
      new Set(['spring-2027', 'fall-2027', 'summer-2027']),
      null
    );
    expect(out.map((s) => s.id)).toEqual(['summer-2027', 'fall-2027', 'spring-2027']);
  });
});

describe('seasonPickerOptions', () => {
  const seasons = [
    season({ id: 'fall-2026', start_date: '2026-09-01', active_flag: true }),
    season({ id: 'spring-2027', start_date: '2027-01-01' }),
  ];

  it('leads with the season being played, not with the latest start date', () => {
    const out = seasonPickerOptions(seasons, new Set(['spring-2027']), null);
    expect(out.map((s) => s.id)).toEqual(['fall-2026', 'spring-2027']);
  });

  it('is just the active season when the member has no history', () => {
    const out = seasonPickerOptions(seasons, new Set(), null);
    expect(out.map((s) => s.id)).toEqual(['fall-2026']);
  });
});

describe('joinedAfterSeason', () => {
  it('is true when the member joined after the term ended', () => {
    expect(joinedAfterSeason('2027-02-01', '2026-12-31', null)).toBe(true);
  });

  it('is false on the last day of the term', () => {
    // The boundary is inclusive: somebody who signed up on 31 December was in
    // the club for that season, however briefly.
    expect(joinedAfterSeason('2026-12-31', '2026-12-31', null)).toBe(false);
  });

  it('does not shift the boundary by a day the way a UTC Date would', () => {
    // 2026-12-31T23:00 in Vancouver is 2027-01-01T07:00Z. The caller passes the
    // CLUB day key, so this member joined inside the season — parsing either
    // side through new Date() is what puts them in the next one.
    expect(joinedAfterSeason('2026-12-31', '2026-12-31', null)).toBe(false);
  });

  it('falls back to the next season start when the term has no end date', () => {
    expect(joinedAfterSeason('2027-03-01', null, '2027-01-01')).toBe(true);
    expect(joinedAfterSeason('2026-11-01', null, '2027-01-01')).toBe(false);
  });

  it('refuses to answer when there is no boundary at all', () => {
    expect(joinedAfterSeason('2027-03-01', null, null)).toBeNull();
  });

  it('refuses to answer when the join date is unknown', () => {
    expect(joinedAfterSeason(null, '2026-12-31', null)).toBeNull();
  });
});

describe('nextSeasonAfter', () => {
  const seasons = [
    season({ id: 'b', start_date: '2027-01-01' }),
    season({ id: 'a', start_date: '2026-09-01' }),
    season({ id: 'c', start_date: '2027-09-01' }),
  ];

  it('finds the next term by start date, not by array order', () => {
    expect(nextSeasonAfter(seasons, 'a')?.id).toBe('b');
  });

  it('is null for the latest season on record', () => {
    expect(nextSeasonAfter(seasons, 'c')).toBeNull();
  });

  it('is null for a season that is not in the list', () => {
    expect(nextSeasonAfter(seasons, 'nope')).toBeNull();
  });
});

describe('formatDayKey', () => {
  it('renders the day the column says, not the evening before', () => {
    expect(formatDayKey('2026-09-01')).toBe('1 SEP 2026');
  });

  it('accepts a timestamp and takes its date part', () => {
    expect(formatDayKey('2026-12-31T00:00:00Z')).toBe('31 DEC 2026');
  });

  it('hands back anything it cannot parse rather than printing Invalid Date', () => {
    expect(formatDayKey('not-a-date')).toBe('not-a-date');
  });
});

describe('formatSeasonRange', () => {
  it('renders a closed term as a range', () => {
    expect(formatSeasonRange(season({ id: 'x' }))).toBe('1 SEP 2026 — 31 DEC 2026');
  });

  it('says what it knows when the term has no end', () => {
    expect(formatSeasonRange(season({ id: 'x', end_date: null }))).toBe('FROM 1 SEP 2026');
  });
});

describe('seasonEmptyReason', () => {
  it('is not empty at all when there are matches', () => {
    expect(
      seasonEmptyReason({ matchCount: 3, hasArchivedRating: false, joinedAfter: true })
    ).toBe('has-matches');
  });

  it('trusts an archived rating over the join date', () => {
    // Being on the ladder when the term was closed off is proof of membership;
    // a created_at that suggests otherwise is the weaker signal.
    expect(
      seasonEmptyReason({ matchCount: 0, hasArchivedRating: true, joinedAfter: true })
    ).toBe('no-matches-but-on-ladder');
  });

  it('says the member joined later when that is all there is to go on', () => {
    expect(
      seasonEmptyReason({ matchCount: 0, hasArchivedRating: false, joinedAfter: true })
    ).toBe('joined-later');
  });

  it('makes no claim about the join date when it could not be answered', () => {
    expect(
      seasonEmptyReason({ matchCount: 0, hasArchivedRating: false, joinedAfter: null })
    ).toBe('nothing-on-record');
  });
});
