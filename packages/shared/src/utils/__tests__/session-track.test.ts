import { describe, it, expect } from 'vitest';
import { SESSION_TRACKS, visibleTracksFor } from '../session-track';

// Every value `player_status` has today (00001_schema.sql:18). Written out
// rather than imported, so that adding a fifth value to the enum without adding
// it here is caught by the coverage assertion below instead of silently
// shrinking what this file tests.
const PLAYER_STATUSES = [
  'competitive',
  'recreational',
  'pending_approval',
  'suspended',
] as const;

describe('visibleTracksFor', () => {
  // THE PROPERTY THE OUTAGE VIOLATED, AND THE ONLY ONE THAT MATTERS FOR
  // CORRECTNESS. `sessions.track` is `session_group`; anything outside that
  // vocabulary is a 22P02 raised at PLAN time, which takes the WHOLE query with
  // it — not the offending row, the query. So the assertion is not "the right
  // tracks" but "never a value the column cannot hold", and it is asserted over
  // arbitrary strings rather than over today's four statuses.
  //
  // A DENYLIST WOULD PASS THE FIRST HALF AND FAIL THE SECOND. Special-casing
  // `pending_approval` and `suspended` satisfies the four known statuses and
  // breaks the day somebody adds a fifth — which is precisely how this bug
  // would come back. The junk cases below are the ones that fail an
  // implementation written that way.
  const vocabulary = new Set<string>(SESSION_TRACKS);

  for (const status of PLAYER_STATUSES) {
    it(`returns only session_group values for status "${status}"`, () => {
      for (const track of visibleTracksFor(status)) {
        expect(vocabulary.has(track), `${track} is not a session_group value`).toBe(true);
      }
    });
  }

  it('stays inside the vocabulary for a status this build has never seen', () => {
    // A future `player_status` value, a column that was not selected, a null
    // from a narrowed select, and an outright nonsense string.
    for (const status of ['alumni', 'inactive', '', 'ALL', null, undefined] as const) {
      for (const track of visibleTracksFor(status)) {
        expect(vocabulary.has(track), `${track} from "${status}"`).toBe(true);
      }
    }
  });

  // THE SYMPTOM, ASSERTED DIRECTLY. Not "the filter is well-formed" — a
  // well-formed filter that matches nothing is the same empty schedule. A
  // member with no track must be offered a filter that can match every session
  // the club runs, whatever track an exec tagged it with.
  it('shows a member with no assigned track every track there is', () => {
    for (const status of ['pending_approval', 'suspended']) {
      expect([...visibleTracksFor(status)].sort()).toEqual([...SESSION_TRACKS].sort());
    }
  });

  it('narrows a member who has a track to their own nights and the club-wide ones', () => {
    expect(visibleTracksFor('competitive')).toEqual(['competitive', 'all']);
    expect(visibleTracksFor('recreational')).toEqual(['recreational', 'all']);
  });

  // 'all' is in every answer, so no mapping can hide a club-wide night from
  // anybody. That is the one row of the table with no legitimate reason to vary.
  it('never withholds the club-wide nights from anyone', () => {
    for (const status of [...PLAYER_STATUSES, 'alumni', null]) {
      expect(visibleTracksFor(status), `${status}`).toContain('all');
    }
  });

  it('pins the session_group vocabulary against the enum', () => {
    expect([...SESSION_TRACKS]).toEqual(['competitive', 'recreational', 'all']);
  });

  // Returns a fresh array every time: the result is handed straight to
  // `.in('track', …)`, and a shared frozen constant leaking out of here would
  // be one accidental `.push` away from a filter that mutates across requests.
  it('hands back an array the caller may keep', () => {
    const first = visibleTracksFor('pending_approval');
    const second = visibleTracksFor('pending_approval');
    expect(first).not.toBe(second);
    expect(first).toEqual(second);
  });
});
