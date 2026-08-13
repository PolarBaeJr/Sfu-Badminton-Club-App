import { describe, it, expect } from 'vitest';
import {
  wallClockToUtc,
  getCheckinWindow,
  isCheckinOpen,
  CLUB_PERMANENT_OFFSET_FROM,
} from '../session-window';

// ============================================================
// Club wall clock -> instant, pinned to fixtures.
//
// These literals were generated ONCE, inside `docker run --rm node:24-alpine`,
// which reports process.versions.tz === '2026b' — the first release carrying
// British Columbia's decision to stop the autumn fall-back. They are checked
// in as data precisely so that no future run has to be on a new enough Node
// for the answer to come out right.
//
// This is the enforcement mechanism, and it is worth being explicit about why
// it is not "remember to use Node 24":
//
//   * Production runs Node 20 (tzdata 2025c). It says UTC-08:00 for every
//     winter date below and would fail these tests if the code trusted it.
//   * The development machine's Node 26.7.0 reports tzdata 2026a. Same
//     answer, also wrong. A version number tells you nothing — only
//     process.versions.tz does, and nothing in CI reads it.
//
// So the code under test does not ask the host at all for dates on or after
// the pin, and these fixtures fail on ANY host the moment that stops being
// true. Run them under Node 20, 22, 24 or 26: same result.
//
// The identical two-branch rule lives in SQL as club_local_instant()
// (00110_session_instants.sql); supabase/tests/00110_checkin_equivalence.sql
// checks the SQL side against the same boundary.
// ============================================================

// [club date, club wall clock, expected UTC instant] under tzdata 2026b.
const FIXTURES_2026B: [string, string, string][] = [
  // Before the pin: PST winter, PDT summer, both DST changeovers. Every
  // tzdata release agrees about these, old and new alike.
  ['2025-12-25', '19:30', '2025-12-26T03:30:00.000Z'],
  ['2026-01-15', '19:30', '2026-01-16T03:30:00.000Z'],
  ['2026-03-07', '23:00', '2026-03-08T07:00:00.000Z'],
  ['2026-03-08', '21:00', '2026-03-09T04:00:00.000Z'],
  ['2026-06-21', '19:30', '2026-06-22T02:30:00.000Z'],
  ['2026-09-15', '19:30', '2026-09-16T02:30:00.000Z'],
  ['2026-10-31', '19:30', '2026-11-01T02:30:00.000Z'],
  // The pin itself. Midnight on 2026-11-01 is UTC-07:00 under BOTH rules,
  // which is what makes a whole-day boundary safe here.
  ['2026-11-01', '00:00', '2026-11-01T07:00:00.000Z'],
  ['2026-11-01', '19:30', '2026-11-02T02:30:00.000Z'],
  // After it. Old tzdata answers an hour later for every one of these.
  ['2026-11-03', '19:30', '2026-11-04T02:30:00.000Z'],
  ['2026-11-03', '21:30', '2026-11-04T04:30:00.000Z'],
  ['2026-11-10', '19:30', '2026-11-11T02:30:00.000Z'],
  ['2026-11-17', '19:30', '2026-11-18T02:30:00.000Z'],
  ['2026-11-24', '19:30', '2026-11-25T02:30:00.000Z'],
  ['2026-12-01', '19:30', '2026-12-02T02:30:00.000Z'],
  ['2026-12-01', '21:30', '2026-12-02T04:30:00.000Z'],
  // Later years: proof the pin is a constant, not one skipped winter. A
  // "BC skips the 2026 fall-back and resumes in March 2027" reading would
  // make 2027-01-15 UTC-08:00 and fail here.
  ['2027-01-15', '19:30', '2027-01-16T02:30:00.000Z'],
  ['2027-07-04', '19:30', '2027-07-05T02:30:00.000Z'],
  ['2030-02-28', '19:30', '2030-03-01T02:30:00.000Z'],
];

describe('wallClockToUtc against tzdata 2026b fixtures', () => {
  it.each(FIXTURES_2026B)('%s %s club time is %s', (date, time, expected) => {
    const [y, mo, d] = date.split('-').map(Number) as [number, number, number];
    const [h, mi] = time.split(':').map(Number) as [number, number];
    expect(wallClockToUtc(y, mo, d, h, mi).toISOString()).toBe(expected);
  });

  it('reads no timezone data at all on or after the pin', () => {
    const pinned = wallClockToUtc(2026, 12, 1, 19, 30);
    expect(pinned.toISOString()).toBe('2026-12-02T02:30:00.000Z');
    // -07:00 exactly: the wall clock read as UTC, plus seven hours.
    expect(pinned.getTime() - Date.UTC(2026, 11, 1, 19, 30)).toBe(7 * 3_600_000);
  });

  it('rolls day overflow before deciding which side of the pin it is on', () => {
    // The next-day-midnight close bound passes day + 1, so 2026-10-31 + 1 has
    // to be recognised as 2026-11-01 and take the pinned branch.
    expect(wallClockToUtc(2026, 10, 31 + 1, 0, 0).toISOString()).toBe('2026-11-01T07:00:00.000Z');
    expect(wallClockToUtc(2026, 11, 30 + 1, 0, 0).toISOString()).toBe('2026-12-01T07:00:00.000Z');
  });

  it('pins from 2026-11-01', () => {
    expect(CLUB_PERMANENT_OFFSET_FROM).toBe('2026-11-01');
  });
});

// ============================================================
// The stored instants win over the wall clock.
// ============================================================

const SETTINGS = { defaultDurationMinutes: 60, opensMinutesBefore: 30 };

describe('getCheckinWindow with stored instants', () => {
  it('uses starts_at/ends_at when the caller selected them', () => {
    const { opensAt, closesAt } = getCheckinWindow(
      {
        date: '2026-11-03',
        start_time: '19:30:00',
        end_time: '21:30:00',
        starts_at: '2026-11-04T02:30:00+00:00',
        ends_at: '2026-11-04T04:30:00+00:00',
      },
      SETTINGS
    );
    expect(opensAt?.toISOString()).toBe('2026-11-04T02:00:00.000Z');
    expect(closesAt.toISOString()).toBe('2026-11-04T04:30:00.000Z');
  });

  it('treats a null ends_at as the runtime-duration branch, not as missing', () => {
    // The database writes NULL here exactly when start_time is set and
    // end_time is not, which is the branch whose close depends on the
    // admin-editable default_duration_minutes.
    const { closesAt } = getCheckinWindow(
      {
        date: '2026-11-03',
        start_time: '19:30:00',
        end_time: null,
        starts_at: '2026-11-04T02:30:00+00:00',
        ends_at: null,
      },
      SETTINGS
    );
    expect(closesAt.toISOString()).toBe('2026-11-04T03:30:00.000Z'); // +60 minutes
  });

  it('still moves both edges when an admin retunes the settings', () => {
    const session = {
      date: '2026-11-03',
      start_time: '19:30:00',
      end_time: null,
      starts_at: '2026-11-04T02:30:00+00:00',
      ends_at: null,
    };
    const wider = getCheckinWindow(session, { defaultDurationMinutes: 180, opensMinutesBefore: 120 });
    expect(wider.opensAt?.toISOString()).toBe('2026-11-04T00:30:00.000Z');
    expect(wider.closesAt.toISOString()).toBe('2026-11-04T05:30:00.000Z');
  });

  it('falls back to the wall clock when the columns were not selected, and agrees', () => {
    const stored = getCheckinWindow(
      {
        date: '2026-11-03',
        start_time: '19:30:00',
        end_time: '21:30:00',
        starts_at: '2026-11-04T02:30:00+00:00',
        ends_at: '2026-11-04T04:30:00+00:00',
      },
      SETTINGS
    );
    const derived = getCheckinWindow(
      { date: '2026-11-03', start_time: '19:30:00', end_time: '21:30:00' },
      SETTINGS
    );
    expect(derived.opensAt?.toISOString()).toBe(stored.opensAt?.toISOString());
    expect(derived.closesAt.toISOString()).toBe(stored.closesAt.toISOString());
  });
});

describe('isCheckinOpen on the far side of the pin', () => {
  const session = {
    date: '2026-11-03',
    start_time: '19:30:00',
    end_time: '21:30:00',
    starts_at: '2026-11-04T02:30:00+00:00',
    ends_at: '2026-11-04T04:30:00+00:00',
  };

  it('opens 30 minutes before 19:30 club time and shuts at 21:30', () => {
    expect(isCheckinOpen(session, new Date('2026-11-04T01:59:59Z'), SETTINGS)).toBe(false);
    expect(isCheckinOpen(session, new Date('2026-11-04T02:00:00Z'), SETTINGS)).toBe(true);
    expect(isCheckinOpen(session, new Date('2026-11-04T04:29:59Z'), SETTINGS)).toBe(true);
    // The hour the old rule wrongly kept the gate open for.
    expect(isCheckinOpen(session, new Date('2026-11-04T04:30:00Z'), SETTINGS)).toBe(false);
    expect(isCheckinOpen(session, new Date('2026-11-04T05:29:00Z'), SETTINGS)).toBe(false);
  });
});
