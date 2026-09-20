import { describe, it, expect } from 'vitest';
import { ACTIVE_CHALLENGE_STATUSES } from '../active-challenges';

describe('ACTIVE_CHALLENGE_STATUSES', () => {
  // Pinned here as well as in the player app because the list is now read by
  // three screens across two apps. An edit made to satisfy one of them has to
  // fail against the SQL cap it was copied from, not just against whichever
  // suite happens to run.
  it('is exactly the set the SQL cap counts', () => {
    expect([...ACTIVE_CHALLENGE_STATUSES]).toEqual(['proposed', 'partially_confirmed', 'accepted']);
  });

  it('excludes every status that is already resolved', () => {
    for (const done of ['completed', 'walkover_confirmed', 'rejected', 'cancelled', 'expired']) {
      expect(ACTIVE_CHALLENGE_STATUSES).not.toContain(done);
    }
  });
});
