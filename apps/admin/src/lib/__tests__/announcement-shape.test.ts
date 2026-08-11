import { describe, it, expect } from 'vitest';
import {
  AUDIENCE_OPTIONS,
  TYPE_OPTIONS,
  audienceLabel,
  bylineName,
  reachPercent,
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
