import { describe, it, expect } from 'vitest';
import { refuseClosedTournament } from '../tournament-closed';

// The gate that was missing entirely until 2026-08-18. Pressing REGISTER on an
// event still at `registration` inside the ARCHIVED Fall Open got all the way
// to the capacity check on staging — every earlier gate waved it through
// because nothing on the path ever read the tournament's own status.

describe('a tournament that is over refuses entry', () => {
  it('refuses an archived tournament', () => {
    expect(refuseClosedTournament('archived', 'enter this event')).toContain('archived');
  });

  it('refuses a completed tournament', () => {
    expect(refuseClosedTournament('completed', 'check in')).toContain('is over');
  });

  it('names what the member was trying to do', () => {
    expect(refuseClosedTournament('archived', 'check in')).toContain('cannot check in');
  });
});

describe('a tournament that is still running lets entry through', () => {
  it('waves an active tournament through', () => {
    expect(refuseClosedTournament('active', 'enter this event')).toBeNull();
  });

  // Unpublished is not the same as over. Refusing draft here would be an
  // untested behaviour change riding along on a fix for something else.
  it('does not refuse a draft tournament', () => {
    expect(refuseClosedTournament('draft', 'enter this event')).toBeNull();
  });

  // A select that forgot to ask for the column must not fail closed and lock
  // every member out of every event.
  it('waves through a status the read never fetched', () => {
    expect(refuseClosedTournament(null, 'enter this event')).toBeNull();
    expect(refuseClosedTournament(undefined, 'enter this event')).toBeNull();
  });
});
