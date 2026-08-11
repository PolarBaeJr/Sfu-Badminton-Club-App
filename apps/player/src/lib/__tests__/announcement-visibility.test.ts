import { describe, it, expect } from 'vitest';
import {
  addressedTo,
  announcementExpiryFilter,
  announcementSeasonFilter,
  isAddressedTo,
  unreadAnnouncementCount,
  withVisibleAnnouncements,
} from '../announcement-visibility';

// THE BUG THESE EXIST FOR: three screens asked "can this member see this
// announcement?" and gave three different answers. /announcements filtered on
// season, /feed did not, and the tab badge filtered on nothing at all — so a
// notice retired with last term's season was invisible on the news screen,
// still on the home screen, and permanently counted in the badge.
//
// The filters are strings handed to PostgREST, so they are asserted as strings:
// what matters is the SHAPE (00085's two columns, not the sessions table's
// nullable season_id) and that a missing active season drops the clause instead
// of producing one that matches nothing.

/** Records what a query builder was asked to filter on. */
function recorder() {
  const calls: string[] = [];
  const builder = {
    calls,
    or(filter: string) {
      calls.push(filter);
      return builder;
    },
  };
  return builder;
}

describe('announcementExpiryFilter', () => {
  it('keeps rows with no expiry and rows that have not expired', () => {
    expect(announcementExpiryFilter('2026-08-11T00:00:00.000Z')).toBe(
      'expires_at.is.null,expires_at.gt.2026-08-11T00:00:00.000Z',
    );
  });
});

describe('announcementSeasonFilter', () => {
  it('uses 00085 two-column shape, not the nullable season_id sessions use', () => {
    const filter = announcementSeasonFilter('season-1');
    expect(filter).toBe('all_seasons.eq.true,season_id.eq.season-1');
    // The sessions shape would match no evergreen row: an evergreen
    // announcement has all_seasons = true AND season_id NULL, and
    // `season_id.is.null` alone would also sweep in nothing else, but the point
    // is that these two filters are not interchangeable.
    expect(filter).not.toContain('season_id.is.null');
  });

  it('drops the clause entirely between terms', () => {
    // Deliberate: a feed gone blank between terms reads as a broken app.
    expect(announcementSeasonFilter(null)).toBeNull();
    expect(announcementSeasonFilter(undefined)).toBeNull();
    expect(announcementSeasonFilter('')).toBeNull();
  });
});

describe('withVisibleAnnouncements', () => {
  const NOW = '2026-08-11T00:00:00.000Z';

  it('applies expiry and season as SEPARATE or() calls', () => {
    // Successive .or()s are ANDed by PostgREST. Folded into one call they would
    // be ORed, and an expired evergreen notice would come back.
    const q = recorder();
    withVisibleAnnouncements(q, NOW, 'season-1');
    expect(q.calls).toEqual([
      'expires_at.is.null,expires_at.gt.2026-08-11T00:00:00.000Z',
      'all_seasons.eq.true,season_id.eq.season-1',
    ]);
  });

  it('still filters expiry when there is no active season', () => {
    const q = recorder();
    withVisibleAnnouncements(q, NOW, null);
    expect(q.calls).toEqual(['expires_at.is.null,expires_at.gt.2026-08-11T00:00:00.000Z']);
  });

  it('returns the builder so the caller can go on chaining', () => {
    const q = recorder();
    expect(withVisibleAnnouncements(q, NOW, 'season-1')).toBe(q);
  });
});

describe('isAddressedTo', () => {
  const competitive = { status: 'competitive', eligibility_flag: false };
  const recreational = { status: 'recreational', eligibility_flag: false };
  const eligible = { status: 'recreational', eligibility_flag: true };

  it("shows 'all' to everyone", () => {
    expect(isAddressedTo({ target_audience: 'all' }, competitive)).toBe(true);
    expect(isAddressedTo({ target_audience: 'all' }, recreational)).toBe(true);
  });

  it('matches a division against the viewer, not the other way round', () => {
    expect(isAddressedTo({ target_audience: 'competitive' }, competitive)).toBe(true);
    expect(isAddressedTo({ target_audience: 'competitive' }, recreational)).toBe(false);
    expect(isAddressedTo({ target_audience: 'recreational' }, recreational)).toBe(true);
  });

  it("gates 'eligible_only' on the flag and never on the division", () => {
    expect(isAddressedTo({ target_audience: 'eligible_only' }, eligible)).toBe(true);
    expect(isAddressedTo({ target_audience: 'eligible_only' }, recreational)).toBe(false);
    // A competitive member who is not eligible must not see it either.
    expect(isAddressedTo({ target_audience: 'eligible_only' }, competitive)).toBe(false);
  });

  it('hides a target_audience it does not recognise', () => {
    // A value from a migration this code has not caught up with. Showing a post
    // to a division it was not addressed to is the worse failure.
    expect(isAddressedTo({ target_audience: 'varsity' }, competitive)).toBe(false);
    expect(isAddressedTo({ target_audience: null }, competitive)).toBe(false);
    expect(isAddressedTo({ target_audience: undefined }, competitive)).toBe(false);
  });

  it('does not let a null status match a null audience', () => {
    // Both null would be `null === null` under a bare equality check, which
    // would show an untargeted row to a member with no division.
    expect(isAddressedTo({ target_audience: null }, { status: null, eligibility_flag: false })).toBe(false);
  });
});

describe('addressedTo', () => {
  it('keeps order and drops what is not for the viewer', () => {
    const rows = [
      { id: 'a', target_audience: 'all' },
      { id: 'b', target_audience: 'competitive' },
      { id: 'c', target_audience: 'eligible_only' },
      { id: 'd', target_audience: 'recreational' },
    ];
    expect(addressedTo(rows, { status: 'recreational', eligibility_flag: true }).map((r) => r.id)).toEqual([
      'a',
      'c',
      'd',
    ]);
  });
});

describe('unreadAnnouncementCount', () => {
  it('is a set difference, not a subtraction of two totals', () => {
    // THE BADGE BUG. Old maths: count(all published) − count(my reads). Here the
    // member has read four things, two of which are no longer visible (retired
    // with last term's season), and can currently see three posts of which one
    // is unread. Subtraction gives 3 − 4 = −1, clamped to 0 — the badge would
    // MISS a genuinely unread post.
    expect(unreadAnnouncementCount(['a', 'b', 'c'], ['a', 'b', 'old-1', 'old-2'])).toBe(1);
  });

  it('never counts a post the member cannot see', () => {
    // The other direction, and the one members actually complained about: two
    // published posts are invisible to this member (wrong division, expired).
    // Subtraction would leave the badge stuck at 2 forever with nothing behind
    // it to click. Only the visible ids are passed in, so it reads 0.
    expect(unreadAnnouncementCount([], ['x'])).toBe(0);
    expect(unreadAnnouncementCount(['a'], ['a'])).toBe(0);
  });

  it('counts every unread visible post', () => {
    expect(unreadAnnouncementCount(['a', 'b', 'c'], [])).toBe(3);
    expect(unreadAnnouncementCount(['a', 'b', 'c'], ['b'])).toBe(2);
  });

  it('does not double-count a duplicated id', () => {
    expect(unreadAnnouncementCount(['a', 'a', 'b'], [])).toBe(2);
  });

  it('is never negative', () => {
    expect(unreadAnnouncementCount([], ['a', 'b'])).toBe(0);
  });
});
