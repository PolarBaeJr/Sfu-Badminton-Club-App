import { describe, it, expect } from 'vitest';
import {
  isRunningEvent,
  isPlayingEvent,
  isUnderWay,
  lastDayOf,
  runningEvents,
  underWayEyebrow,
  type FeedEvent,
  type FeedTournament,
} from '@/lib/feed-tournament';
import type { TournamentEventType } from '@badminton/shared';

const ev = (status: string, event_type: TournamentEventType = 'open_singles'): FeedEvent => ({
  id: `e-${status}-${event_type}`,
  event_type,
  status,
});

const tournament = (over: Partial<FeedTournament> = {}): FeedTournament => ({
  id: 't1',
  name: 'Autumn Open',
  start_date: '2026-08-17',
  end_date: '2026-08-17',
  tournament_events: [ev('live')],
  ...over,
});

// Every value the CHECK on tournament_events allows, as of 00107. Written out so
// a migration adding an eighth is a decision somebody has to make here rather
// than a status that silently falls through one branch or the other.
const ALL_STATUSES = [
  'registration',
  'checkin',
  'pool_generated',
  'pool_live',
  'bracket_generated',
  'live',
  'completed',
] as const;

describe('isRunningEvent — what "on" means for one event', () => {
  it('excludes exactly the two ends of the lifecycle and nothing else', () => {
    const running = ALL_STATUSES.filter((s) => isRunningEvent(ev(s)));
    expect(running).toEqual(['checkin', 'pool_generated', 'pool_live', 'bracket_generated', 'live']);
  });

  it('counts the two pool statuses 00107 added', () => {
    // The point of the deny-list. An allow-list written against the five
    // statuses in 00001 would have dropped the whole pool_to_bracket format,
    // and the symptom would have been a card that just never appeared.
    expect(isRunningEvent(ev('pool_generated'))).toBe(true);
    expect(isRunningEvent(ev('pool_live'))).toBe(true);
  });

  it('does not count an event still taking entries', () => {
    // /tournaments leads with `registration` as its "entries open" hero. If this
    // returned true, the same event would be advertised as "entries open" on one
    // screen and "under way" on the other.
    expect(isRunningEvent(ev('registration'))).toBe(false);
  });
});

describe('isPlayingEvent — a draw exists, so there are courts', () => {
  it('separates drawn-or-playing from merely open for check-in', () => {
    expect(ALL_STATUSES.filter((s) => isPlayingEvent(ev(s)))).toEqual([
      'pool_generated',
      'pool_live',
      'bracket_generated',
      'live',
    ]);
  });
});

describe('lastDayOf — end_date is nullable and the admin form lets it be blank', () => {
  it('uses end_date when it is set', () => {
    expect(lastDayOf({ start_date: '2026-08-15', end_date: '2026-08-17' })).toBe('2026-08-17');
  });

  it('falls back to start_date when it is not', () => {
    expect(lastDayOf({ start_date: '2026-08-15', end_date: null })).toBe('2026-08-15');
  });

  it('trims a timestamp to a day key, so the compare stays a string compare', () => {
    expect(lastDayOf({ start_date: '2026-08-15', end_date: '2026-08-17T00:00:00Z' })).toBe('2026-08-17');
  });
});

describe('isUnderWay — the definition, and the stale case it exists to kill', () => {
  it('THE PRODUCTION TRAP: an event left at `live` on a tournament that ended last month', () => {
    // This is not hypothetical. Read off the production database on 2026-08-17:
    // one tournament, status='active', not suspended, in the active season,
    // start_date = end_date = 2026-07-24, and its womens_singles event still at
    // `live` three and a half weeks later. Nothing ever walks an event back to
    // `completed` when the gym empties, so a definition keyed on status alone
    // would have put "UNDER WAY" on every member's landing screen today.
    const stale = tournament({
      name: 'Test Competition 1',
      start_date: '2026-07-24',
      end_date: '2026-07-24',
      tournament_events: [ev('completed', 'mens_singles'), ev('completed', 'open_singles'), ev('live', 'womens_singles')],
    });
    expect(stale.tournament_events.some(isRunningEvent)).toBe(true); // status says yes
    expect(isUnderWay(stale, '2026-08-17')).toBe(false); // the date bound says no
  });

  it('is true on the day', () => {
    expect(isUnderWay(tournament(), '2026-08-17')).toBe(true);
  });

  it('is inclusive of the final day — end_date means "this day inclusive"', () => {
    const multiDay = tournament({ start_date: '2026-08-15', end_date: '2026-08-17' });
    expect(isUnderWay(multiDay, '2026-08-17')).toBe(true);
    expect(isUnderWay(multiDay, '2026-08-18')).toBe(false);
  });

  it('survives the middle day of a multi-day tournament', () => {
    expect(isUnderWay(tournament({ start_date: '2026-08-15', end_date: '2026-08-19' }), '2026-08-17')).toBe(true);
  });

  it('shows an undated tournament only on its start day, which is the safe direction', () => {
    const undated = tournament({ start_date: '2026-08-17', end_date: null });
    expect(isUnderWay(undated, '2026-08-17')).toBe(true);
    expect(isUnderWay(undated, '2026-08-18')).toBe(false);
  });

  it('is false when every event is still taking entries', () => {
    // /tournaments owns this case with its "Entries open" hero. The feed banner
    // is about a tournament being PLAYED.
    expect(isUnderWay(tournament({ tournament_events: [ev('registration')] }), '2026-08-17')).toBe(false);
  });

  it('is false when every event has finished, even inside the date window', () => {
    expect(isUnderWay(tournament({ tournament_events: [ev('completed')] }), '2026-08-17')).toBe(false);
  });

  it('is true if ANY event is running, whatever the others are doing', () => {
    expect(
      isUnderWay(
        tournament({ tournament_events: [ev('completed', 'mens_singles'), ev('checkin', 'mixed_doubles')] }),
        '2026-08-17',
      ),
    ).toBe(true);
  });

  it('is false for a tournament with no events at all', () => {
    expect(isUnderWay(tournament({ tournament_events: [] }), '2026-08-17')).toBe(false);
  });

  it('does not crash on a nested embed PostgREST returned as null', () => {
    expect(isUnderWay(tournament({ tournament_events: null as unknown as FeedEvent[] }), '2026-08-17')).toBe(false);
  });

  it('is a STRING compare, so a date is never parsed as UTC midnight', () => {
    // The bug isUpcoming() in tournament-index.ts documents: `new Date()` on a
    // Postgres DATE reads it as UTC midnight, so from ~16:00 Vancouver today's
    // tournament read as already over. Day keys are compared as text instead.
    // 2026-11-02 is the day after BC drops its winter fallback, which is exactly
    // the sort of date a Date-based compare goes wrong on.
    const t = tournament({ start_date: '2026-11-02', end_date: '2026-11-02' });
    expect(isUnderWay(t, '2026-11-02')).toBe(true);
    expect(isUnderWay(t, '2026-11-03')).toBe(false);
  });
});

describe('runningEvents', () => {
  it('keeps the query order and drops the finished and the not-yet-drawn', () => {
    const t = tournament({
      tournament_events: [
        ev('completed', 'mens_singles'),
        ev('live', 'womens_singles'),
        ev('registration', 'open_singles'),
        ev('checkin', 'mixed_doubles'),
      ],
    });
    expect(runningEvents(t).map((e) => e.event_type)).toEqual(['womens_singles', 'mixed_doubles']);
  });
});

describe('underWayEyebrow — two states, because they ask for different things', () => {
  it('says UNDER WAY once anything is drawn or being played', () => {
    expect(underWayEyebrow([ev('checkin'), ev('live')])).toBe('UNDER WAY');
    expect(underWayEyebrow([ev('bracket_generated')])).toBe('UNDER WAY');
    expect(underWayEyebrow([ev('pool_live')])).toBe('UNDER WAY');
  });

  it('says CHECK-IN OPEN when the desk is taking names and nothing is drawn', () => {
    // Sending somebody to find a court that does not exist yet is the failure
    // a single combined label would cause.
    expect(underWayEyebrow([ev('checkin')])).toBe('CHECK-IN OPEN');
  });
});
