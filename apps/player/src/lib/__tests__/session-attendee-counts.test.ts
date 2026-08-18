import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  attendeeCountsBySession,
  __resetAttendeeCountWarning,
  type AttendanceReader,
} from '../session-attendee-counts';

// FIX-LIST #12 — "no-show and absence history is world-readable".
//
// The leak is an RLS predicate, and 00153 is the fix. What this file guards is
// the precondition: the members' app had ONE cross-member read of
// session_attendance, and until it stops needing the rows, narrowing the policy
// turns every session card's attendee count silently into 0 — the read does not
// fail, it just returns the viewer's own row.

const rpc = vi.fn();
const range = vi.fn();

function reader(): AttendanceReader {
  return {
    rpc,
    from: () => ({
      select: () => ({
        in: () => ({ in: () => ({ order: () => ({ range }) }) }),
      }),
    }),
  } as unknown as AttendanceReader;
}

beforeEach(() => {
  rpc.mockReset();
  range.mockReset();
  __resetAttendeeCountWarning();
  vi.restoreAllMocks();
});

describe('a session card gets its number from an aggregate', () => {
  it('uses the RPC and never asks for the rows', async () => {
    rpc.mockResolvedValue({
      data: [{ session_id: 's1', attendees: 12 }, { session_id: 's2', attendees: 3 }],
      error: null,
    });

    const counts = await attendeeCountsBySession(reader(), ['s1', 's2']);

    expect(counts).toEqual({ s1: 12, s2: 3 });
    // THE POINT OF THE WHOLE ITEM. If the rows are still being read, 00153
    // breaks this screen the day it is applied.
    expect(range).not.toHaveBeenCalled();
    expect(rpc).toHaveBeenCalledWith('get_session_attendee_counts', { p_session_ids: ['s1', 's2'] });
  });

  it('a session nobody attended reads as 0, not as undefined', async () => {
    // The function GROUPs, so a session with no attendees returns no row at all.
    // A caller that trusted the map would print "undefined going".
    rpc.mockResolvedValue({ data: [{ session_id: 's1', attendees: 4 }], error: null });
    const counts = await attendeeCountsBySession(reader(), ['s1', 's2']);
    expect(counts.s2 ?? 0).toBe(0);
  });

  it('asks nothing at all for an empty list', async () => {
    expect(await attendeeCountsBySession(reader(), [])).toEqual({});
    expect(rpc).not.toHaveBeenCalled();
  });

  it('falls back to the rows while 00152 is unapplied, and says so once', async () => {
    // Migrations here are applied by hand, so "deployed but not applied" is a
    // real window. Without the fallback every card would read 0 through it.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    rpc.mockResolvedValue({ data: null, error: { code: 'PGRST202' } });
    range.mockResolvedValue({
      data: [{ session_id: 's1' }, { session_id: 's1' }, { session_id: 's2' }],
      error: null,
    });

    expect(await attendeeCountsBySession(reader(), ['s1', 's2'])).toEqual({ s1: 2, s2: 1 });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toContain('00152');

    // Once per process, not once per page load: this runs on every member's
    // schedule render.
    range.mockResolvedValue({ data: [{ session_id: 's1' }], error: null });
    await attendeeCountsBySession(reader(), ['s1']);
    expect(warn).toHaveBeenCalledTimes(1);
  });
});

describe('the schedule page no longer reads other members\' attendance rows', () => {
  const page = readFileSync(
    join(__dirname, '..', '..', 'app', 'sessions', 'page.tsx'),
    'utf8',
  );

  it('has no session_attendance query that is not the viewer\'s own', () => {
    // Every remaining `from('session_attendance')` chain in this file must
    // carry a player_id filter. This is the check that would have failed before
    // the change and the one that fails again if the tally read comes back.
    const chains = page.split(/from\('session_attendance'\)/).slice(1)
      .map((tail) => tail.split(';')[0] ?? '');
    for (const chain of chains) {
      expect(chain, `an unscoped session_attendance read is back:\n${chain}`)
        .toMatch(/\.eq\('player_id'/);
    }
  });

  it('gets the tally from the aggregate helper instead', () => {
    expect(page).toMatch(/attendeeCountsBySession\(supabase as never, talliedSessionIds\)/);
  });
});
