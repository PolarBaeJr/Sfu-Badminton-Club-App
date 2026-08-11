import { describe, it, expect } from 'vitest';
import {
  AUDIENCE_OPTIONS,
  TYPE_OPTIONS,
  audienceLabel,
  bylineName,
  reachPercent,
  tallyOpens,
  typeBadge,
} from '../../app/announcements/announcement-shape';

// The two enums this screen writes into, copied from 00001_schema.sql (595 and
// 597). If a migration widens either, this fails and the select is updated —
// which is the point. A form offering a value Postgres rejects is a form that
// cannot save, and one MISSING a value silently hides a category from the club.
const ANNOUNCEMENT_TYPE = ['info', 'warning', 'urgent', 'event'];
const ANNOUNCEMENT_AUDIENCE = ['all', 'competitive', 'recreational', 'eligible_only'];

describe('announcement vocabulary', () => {
  it('offers exactly the announcement_type enum', () => {
    expect(TYPE_OPTIONS.map((o) => o.value).sort()).toEqual([...ANNOUNCEMENT_TYPE].sort());
  });

  it('offers exactly the announcement_audience enum', () => {
    expect(AUDIENCE_OPTIONS.map((o) => o.value).sort()).toEqual([...ANNOUNCEMENT_AUDIENCE].sort());
  });

  it('gives every real category a badge', () => {
    for (const type of ANNOUNCEMENT_TYPE) {
      expect(typeBadge(type).label).toBe(type.toUpperCase());
    }
  });

  it('falls back rather than returning undefined for a category it has never seen', () => {
    // A fifth value added by a future migration must render as itself, not
    // pass `undefined` into the Badge variant prop.
    const badge = typeBadge('venue');
    expect(badge.variant).toBe('neutral');
    expect(badge.label).toBe('VENUE');
  });

  it('labels an unknown audience as itself', () => {
    expect(audienceLabel('all')).toBe('Every member');
    expect(audienceLabel('varsity')).toBe('varsity');
  });
});

describe('reachPercent', () => {
  it('is opens over the targeted audience', () => {
    expect(reachPercent(152, 214)).toBe(71);
    expect(reachPercent(0, 214)).toBe(0);
    expect(reachPercent(214, 214)).toBe(100);
  });

  it('clamps above 100', () => {
    // announcement_reads is not constrained to the audience: RLS lets any
    // member read any published post, so a reader outside the target adds to
    // the numerator and not the denominator. Uncapped this renders 104%.
    expect(reachPercent(20, 19)).toBe(100);
  });

  it('returns null rather than dividing by nobody', () => {
    expect(reachPercent(0, 0)).toBeNull();
    expect(reachPercent(3, -1)).toBeNull();
  });
});

describe('bylineName', () => {
  it('initials the given name and shouts the surname', () => {
    expect(bylineName('Alice Mercer')).toBe('A. MERCER');
    expect(bylineName('  mei  ling  tan ')).toBe('M. TAN');
  });

  it('keeps a single-word name whole', () => {
    // "A." would name nobody.
    expect(bylineName('Prince')).toBe('PRINCE');
  });

  it('has nothing to say about a missing name', () => {
    expect(bylineName(null)).toBeNull();
    expect(bylineName(undefined)).toBeNull();
    expect(bylineName('   ')).toBeNull();
  });
});

// THE OPENED FIGURES, AFTER THEY STOPPED BEING ONE COUNT QUERY PER POST.
//
// The page now pages every receipt in and buckets them here, so the property
// worth proving is that the swap changed the number of round trips and NOT a
// single figure: the same counts, exact, with a draft still absent rather than
// zero.
describe('tallyOpens', () => {
  const receipt = (id: string) => ({ announcement_id: id });

  it('counts every receipt against its own post', () => {
    const counts = tallyOpens(
      [receipt('a'), receipt('b'), receipt('a'), receipt('a'), receipt('b')],
      ['a', 'b'],
    );

    expect(counts.get('a')).toBe(3);
    expect(counts.get('b')).toBe(2);
  });

  it('gives a published post with no readers a zero', () => {
    const counts = tallyOpens([receipt('a')], ['a', 'b']);

    // Nobody has opened b, which is a real answer and a different one from
    // "b is a draft".
    expect(counts.get('b')).toBe(0);
    expect(counts.has('b')).toBe(true);
  });

  it('leaves a draft out of the map entirely', () => {
    // A receipt CAN exist against a post that is a draft today — publish it,
    // members read it, revert it — and it still must not produce a figure the
    // byline would print.
    const counts = tallyOpens([receipt('draft'), receipt('live')], ['live']);

    expect(counts.has('draft')).toBe(false);
    expect(counts.get('draft')).toBeUndefined();
    expect(counts.get('live')).toBe(1);
  });

  it('never folds an unknown post into another post’s total', () => {
    const counts = tallyOpens([receipt('a'), receipt('ghost'), receipt('a')], ['a']);

    expect([...counts.entries()]).toEqual([['a', 2]]);
  });

  it('is exact across a page boundary', () => {
    // The caller reads in windows of 1000 and concatenates; this asserts the
    // arithmetic does not care where the windows fell.
    const many = Array.from({ length: 2500 }, () => receipt('a'));
    expect(tallyOpens(many, ['a']).get('a')).toBe(2500);
  });

  it('has nothing to count when nothing is published', () => {
    expect([...tallyOpens([receipt('a')], []).entries()]).toEqual([]);
  });
});
