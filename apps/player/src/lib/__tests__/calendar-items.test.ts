import { describe, it, expect } from 'vitest';
import { FALLBACK_CHECKIN_SETTINGS } from '@badminton/shared';
import {
  buildAgenda,
  buildWeekStrip,
  clubEventCalendarItem,
  compareCalendarItems,
  sessionCalendarItem,
  tournamentCalendarItems,
  type CalendarClubEventRow,
  type CalendarItem,
  type CalendarTournamentRow,
} from '@/lib/calendar-items';

const SETTINGS = { ...FALLBACK_CHECKIN_SETTINGS, opensMinutesBefore: null, defaultDurationMinutes: 120 };

function session(overrides: Partial<{ id: string; name: string | null; date: string; start_time: string | null; end_time: string | null; status: string }> = {}) {
  return { id: 's1', name: 'Ladder Night', date: '2026-10-14', start_time: '18:30:00', end_time: '21:00:00', status: 'open', ...overrides };
}

function clubEvent(overrides: Partial<CalendarClubEventRow> = {}): CalendarClubEventRow {
  return {
    id: 'e1',
    title: 'Club Social',
    kind: 'social',
    location: null,
    starts_at: '2026-10-15T02:30:00Z',
    ends_at: null,
    status: 'published',
    ...overrides,
  };
}

function tournament(overrides: Partial<CalendarTournamentRow> = {}): CalendarTournamentRow {
  return {
    id: 't1',
    name: 'Fall Open',
    start_date: '2026-10-17',
    end_date: '2026-10-19',
    status: 'active',
    suspended_at: null,
    ...overrides,
  };
}

function item(overrides: Partial<CalendarItem>): CalendarItem {
  return {
    key: 'k',
    id: 'x',
    kind: 'session',
    date: '2026-10-14',
    allDay: false,
    sortTime: null,
    name: 'A',
    timeLabel: null,
    tone: 'open',
    mine: false,
    href: null,
    ...overrides,
  };
}

describe('sessionCalendarItem', () => {
  it('tones open and closed nights apart', () => {
    expect(sessionCalendarItem(session(), { mine: false, hasCard: true }).tone).toBe('open');
    expect(sessionCalendarItem(session({ status: 'closed' }), { mine: false, hasCard: false }).tone).toBe('closed');
  });

  it('links to the card only when there is one', () => {
    expect(sessionCalendarItem(session(), { mine: false, hasCard: true }).href).toBe('#session-s1');
    expect(sessionCalendarItem(session(), { mine: false, hasCard: false }).href).toBeNull();
  });

  it('has no time when the session has no start time', () => {
    const it0 = sessionCalendarItem(session({ start_time: null, name: null }), { mine: true, hasCard: false });
    expect(it0.sortTime).toBeNull();
    expect(it0.timeLabel).toBeNull();
    expect(it0.name).toBe('Practice Session');
    expect(it0.mine).toBe(true);
  });
});

describe('clubEventCalendarItem', () => {
  it('places an event on its club date past the 2026-11-01 cutover', () => {
    const it0 = clubEventCalendarItem(clubEvent({ starts_at: '2026-11-02T07:30:00Z' }), { mine: false });
    expect(it0.date).toBe('2026-11-02');
    expect(it0.sortTime).toBe('00:30');
    expect(it0.timeLabel).toBe('12:30 AM');
  });

  it('places an evening event on its club date, not its UTC date', () => {
    expect(clubEventCalendarItem(clubEvent(), { mine: false }).date).toBe('2026-10-14');
  });

  it('tones a cancelled event and links to the event page', () => {
    const it0 = clubEventCalendarItem(clubEvent({ status: 'cancelled' }), { mine: true });
    expect(it0.tone).toBe('cancelled');
    expect(it0.href).toBe('/events/e1');
    expect(clubEventCalendarItem(clubEvent(), { mine: false }).tone).toBe('club');
  });
});

describe('tournamentCalendarItems', () => {
  it('puts one all-day item on each day, with unique keys', () => {
    const items = tournamentCalendarItems(tournament());
    expect(items.map((i) => i.date)).toEqual(['2026-10-17', '2026-10-18', '2026-10-19']);
    expect(new Set(items.map((i) => i.key)).size).toBe(3);
    expect(items.every((i) => i.allDay && i.href === '/tournaments/t1')).toBe(true);
  });

  it('caps a long run at seven days', () => {
    expect(tournamentCalendarItems(tournament({ end_date: '2026-12-31' }))).toHaveLength(7);
  });

  it('treats a missing end date as one day', () => {
    expect(tournamentCalendarItems(tournament({ end_date: null }))).toHaveLength(1);
  });
});

describe('compareCalendarItems', () => {
  it('orders all-day first, then by time, then untimed last', () => {
    const sorted = [
      item({ key: 'untimed', sortTime: null }),
      item({ key: 'late', sortTime: '20:00' }),
      item({ key: 'allday', allDay: true }),
      item({ key: 'early', sortTime: '09:00' }),
      item({ key: 'tomorrow', date: '2026-10-15', allDay: true }),
    ].sort(compareCalendarItems);
    expect(sorted.map((i) => i.key)).toEqual(['allday', 'early', 'late', 'untimed', 'tomorrow']);
  });
});

describe('buildWeekStrip', () => {
  it('starts today and runs seven days across a month boundary', () => {
    const week = buildWeekStrip([], '2026-09-28');
    expect(week.map((d) => d.dateISO)).toEqual([
      '2026-09-28', '2026-09-29', '2026-09-30', '2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04',
    ]);
    expect(week.map((d) => d.isToday)).toEqual([true, false, false, false, false, false, false]);
    expect(week[0]?.weekday).toBe('Mon');
    expect(week[3]?.day).toBe(1);
  });

  it('caps the marks at three and counts the rest', () => {
    const items = ['a', 'b', 'c', 'd', 'e'].map((key) => item({ key, date: '2026-10-14' }));
    const [today] = buildWeekStrip(items, '2026-10-14');
    expect(today?.marks).toHaveLength(3);
    expect(today?.more).toBe(2);
  });

  it('spells the day out without an em dash', () => {
    const items = [
      item({ key: 'a', date: '2026-10-14', kind: 'session' }),
      item({ key: 'b', date: '2026-10-14', kind: 'club_event', tone: 'club' }),
    ];
    const [today, tomorrow] = buildWeekStrip(items, '2026-10-14');
    expect(today?.summary).toBe('Wed 14: 1 session, 1 club event');
    expect(tomorrow?.summary).toBe('Thu 15: nothing on');
    expect(today?.summary).not.toContain(String.fromCharCode(0x2014));
  });
});

describe('buildAgenda', () => {
  const base = {
    sessions: [] as ReturnType<typeof session>[],
    clubEvents: [] as CalendarClubEventRow[],
    tournaments: [] as CalendarTournamentRow[],
    todayISO: '2026-10-14',
    checkinSettings: SETTINGS,
    liveTournamentIds: new Set<string>(),
  };

  it('keeps tonight until check-in closes and drops a night whose window has shut', () => {
    const now = new Date('2026-10-15T03:00:00Z'); // 20:00 club time on the 14th
    const days = buildAgenda({
      ...base,
      now,
      sessions: [
        session({ id: 'tonight' }),
        session({ id: 'yesterday', date: '2026-10-13' }),
      ],
    });
    expect(days.flatMap((d) => d.sessions.map((e) => e.key))).toEqual(['session:tonight']);
  });

  it('drops a finished club event and keeps a future cancelled one', () => {
    const now = new Date('2026-10-15T03:00:00Z');
    const days = buildAgenda({
      ...base,
      now,
      clubEvents: [
        clubEvent({ id: 'over', starts_at: '2026-10-14T20:00:00Z', ends_at: '2026-10-14T22:00:00Z' }),
        clubEvent({ id: 'cancelled', status: 'cancelled', starts_at: '2026-10-16T02:00:00Z' }),
      ],
    });
    expect(days.flatMap((d) => d.sessions.map((e) => e.key))).toEqual(['club_event:cancelled']);
  });

  it('keeps an event with no end time until the default length has passed', () => {
    const days = buildAgenda({
      ...base,
      now: new Date('2026-10-15T04:00:00Z'),
      clubEvents: [clubEvent()],
    });
    expect(days).toHaveLength(1);
  });

  it('caps the club events at ten', () => {
    const clubEvents = Array.from({ length: 12 }, (_, i) =>
      clubEvent({ id: `e${i}`, starts_at: `2026-10-${String(16 + i).padStart(2, '0')}T02:00:00Z` }),
    );
    const days = buildAgenda({ ...base, now: new Date('2026-10-15T03:00:00Z'), clubEvents });
    expect(days.flatMap((d) => d.sessions)).toHaveLength(10);
  });

  it('leaves out live, suspended, finished and draft tournaments', () => {
    const days = buildAgenda({
      ...base,
      now: new Date('2026-10-15T03:00:00Z'),
      liveTournamentIds: new Set(['live']),
      tournaments: [
        tournament({ id: 'live' }),
        tournament({ id: 'suspended', suspended_at: '2026-10-01T00:00:00Z' }),
        tournament({ id: 'over', start_date: '2026-10-01', end_date: '2026-10-02' }),
        tournament({ id: 'draft', status: 'draft' }),
        tournament({ id: 'running', start_date: '2026-10-12', end_date: '2026-10-15' }),
        tournament({ id: 'soon' }),
      ],
    });
    const entries = days.flatMap((d) => d.sessions.map((e) => [e.key, e.date]));
    expect(entries).toEqual([
      ['tournament:running', '2026-10-14'],
      ['tournament:soon', '2026-10-17'],
    ]);
  });

  it('groups by day in order, with all-day first inside a day', () => {
    const days = buildAgenda({
      ...base,
      now: new Date('2026-10-14T16:00:00Z'),
      sessions: [session({ id: 'late', date: '2026-10-17' }), session({ id: 'today' })],
      clubEvents: [clubEvent({ id: 'soc', starts_at: '2026-10-17T01:00:00Z' })],
      tournaments: [tournament()],
    });
    expect(days.map((d) => d.dateISO)).toEqual(['2026-10-14', '2026-10-16', '2026-10-17']);
    expect(days[0]?.isToday).toBe(true);
    expect(days[2]?.sessions.map((e) => e.kind)).toEqual(['tournament', 'session']);
    expect(days[1]?.sessions.map((e) => e.kind)).toEqual(['club_event']);
  });
});
