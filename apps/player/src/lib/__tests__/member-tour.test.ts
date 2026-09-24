import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { selectSteps, resolveTarget, shouldAutoStart, type TourContext } from '@badminton/ui/src/tour';
import { flattenEntries } from '@badminton/ui/src/nav-groups';
import { ALL_FEATURES_ENABLED, type FeatureFlags } from '@badminton/shared/src/utils/features';
import { MEMBER_TOUR_KEY, MEMBER_TOUR_STEPS } from '../tours/member-tour';
import { DESKTOP_ENTRIES, MOBILE_SLOTS } from '../nav-entries';

// WHO GETS WHICH STEP, and whether every selector the tour points at is still
// on the element it names. The tour is never mounted here (no DOM); the render
// itself is tour-render.test.tsx, and a green suite says nothing about the
// spotlight landing in the right place on a real screen.

const NONE: ReadonlySet<string> = new Set();

function ctx(overrides: Partial<TourContext> = {}): TourContext {
  return {
    features: { ...ALL_FEATURES_ENABLED },
    featureAccess: [],
    approved: true,
    held: NONE,
    ...overrides,
  };
}

const off = (...ids: (keyof FeatureFlags)[]): FeatureFlags => {
  const flags = { ...ALL_FEATURES_ENABLED };
  for (const id of ids) flags[id] = false;
  return flags;
};

const ids = (c: TourContext) => selectSteps(MEMBER_TOUR_STEPS, c).map((s) => s.id);
// Steps by position in the full list, 1-based, the way the plan numbers them.
const numbers = (c: TourContext) =>
  selectSteps(MEMBER_TOUR_STEPS, c).map((s) => MEMBER_TOUR_STEPS.indexOf(s) + 1);

describe('the member tour steps', () => {
  it('has eleven steps with every feature on', () => {
    expect(MEMBER_TOUR_STEPS).toHaveLength(11);
    expect(numbers(ctx())).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
  });

  it('drops the session step with sessions off, keeping the calendar and the subscribe button for events', () => {
    const got = numbers(ctx({ features: off('sessions') }));
    expect(got).not.toContain(3);
    expect(got).toContain(2);
    expect(got).toContain(4);
    // Step 4 is sessions OR events; with both off it goes too.
    expect(numbers(ctx({ features: off('sessions', 'events') }))).not.toContain(4);
  });

  it('drops the calendar only when sessions, events and tournaments are all off', () => {
    expect(numbers(ctx({ features: off('sessions', 'events') }))).toContain(2);
    expect(numbers(ctx({ features: off('sessions', 'events', 'tournaments') }))).not.toContain(2);
  });

  it('drops challenges with challenges off', () => {
    expect(ids(ctx({ features: off('challenges') }))).not.toContain('challenges');
  });

  it('gives a pending signup no session, challenges or events step', () => {
    const got = numbers(ctx({ approved: false }));
    expect(got).not.toContain(3);
    expect(got).not.toContain(6);
    expect(got).not.toContain(8);
    expect(got).toEqual([1, 2, 4, 5, 7, 9, 10, 11]);
  });

  it('keeps a switched-off feature for somebody who holds its key', () => {
    expect(ids(ctx({ features: off('challenges'), featureAccess: ['challenges'] }))).toContain('challenges');
    expect(ids(ctx({ features: off('leaderboard'), featureAccess: ['leaderboard'] }))).toContain('ranks');
  });

  it('always keeps the three cards', () => {
    const everythingOff = off(
      'sessions', 'challenges', 'tournaments', 'events', 'leaderboard', 'my_stats', 'announcements', 'fees',
    );
    expect(ids(ctx({ features: everythingOff, approved: false }))).toEqual([
      'welcome', 'activity', 'settings', 'done',
    ]);
  });

  it('uses the member key', () => {
    expect(MEMBER_TOUR_KEY).toBe('member_v1');
  });
});

describe('resolveTarget', () => {
  it('takes the first visible selector', () => {
    const seen = new Set(['b', 'c']);
    expect(resolveTarget(['a', 'b', 'c'], (s) => seen.has(s))).toBe('b');
  });

  it('is null when nothing is visible, or there is nothing to look for', () => {
    expect(resolveTarget(['a', 'b'], () => false)).toBeNull();
    expect(resolveTarget([], () => true)).toBeNull();
  });
});

describe('shouldAutoStart', () => {
  const base = {
    tourKey: MEMBER_TOUR_KEY,
    toursSeen: {},
    localSeen: false,
    pathname: '/feed',
    startPaths: ['/feed'] as const,
    blocked: false,
    forced: false,
  };

  it('starts a first visit to the feed', () => {
    expect(shouldAutoStart(base)).toBe(true);
  });

  it('does not start once the server has it as seen', () => {
    expect(shouldAutoStart({ ...base, toursSeen: { member_v1: '2026-09-23T00:00:00Z' } })).toBe(false);
  });

  it('starts again for a new version of the tour', () => {
    expect(shouldAutoStart({ ...base, toursSeen: { exec_v1: '2026-09-23T00:00:00Z' } })).toBe(true);
  });

  it('does not start once this device has it as seen', () => {
    expect(shouldAutoStart({ ...base, localSeen: true })).toBe(false);
  });

  it('does not start behind a gate', () => {
    expect(shouldAutoStart({ ...base, blocked: true })).toBe(false);
  });

  it('does not start anywhere but the feed', () => {
    expect(shouldAutoStart({ ...base, pathname: '/leaderboard' })).toBe(false);
  });

  it('a replay starts anywhere, even when seen, but never behind a gate', () => {
    expect(
      shouldAutoStart({ ...base, forced: true, pathname: '/settings', localSeen: true, toursSeen: { member_v1: 'x' } }),
    ).toBe(true);
    expect(shouldAutoStart({ ...base, forced: true, blocked: true })).toBe(false);
  });

  it("'*' starts on any path", () => {
    expect(shouldAutoStart({ ...base, startPaths: '*', pathname: '/players' })).toBe(true);
  });
});

// THE SELECTORS ARE STRINGS, and nothing but these tests ties them to the
// attributes they name. Rename an attribute and the step silently skips.
describe('the tour selectors still match the markup', () => {
  const src = (rel: string) => readFileSync(join(__dirname, '..', '..', rel), 'utf8');
  const targets = MEMBER_TOUR_STEPS.flatMap((s) => s.targets);

  it('every data-tour-nav href is a real nav destination', () => {
    const hrefs = new Set(
      [...flattenEntries(DESKTOP_ENTRIES), ...flattenEntries(MOBILE_SLOTS)].map((item) => item.href),
    );
    const groups = new Set(
      [...DESKTOP_ENTRIES, ...MOBILE_SLOTS].flatMap((e) => (e.kind === 'group' ? [e.group.id] : [])),
    );
    const named = targets.flatMap((t) => [...t.matchAll(/data-tour-nav="([^"]+)"/g)].map((m) => m[1]!));
    expect(named.length).toBeGreaterThan(0);
    for (const value of named) {
      if (value.startsWith('group:')) expect(groups, value).toContain(value.slice('group:'.length));
      else expect(hrefs, value).toContain(value);
    }
  });

  it('every data-nav-group id is a real desktop group', () => {
    const groups = new Set(DESKTOP_ENTRIES.flatMap((e) => (e.kind === 'group' ? [e.group.id] : [])));
    const named = targets.flatMap((t) => [...t.matchAll(/data-nav-group="([^"]+)"/g)].map((m) => m[1]!));
    expect(named.length).toBeGreaterThan(0);
    for (const id of named) expect(groups, id).toContain(id);
  });

  it('the components still carry the nav attributes', () => {
    expect(src('components/top-bar.tsx')).toContain('data-tour-nav={item.href}');
    expect(src('components/bottom-nav.tsx')).toContain('data-tour-nav={item.href}');
    expect(src('components/bottom-nav.tsx')).toContain('data-tour-nav={`group:${group.id}`}');
    expect(
      readFileSync(join(__dirname, '../../../../../packages/ui/src/components/NavMenu.tsx'), 'utf8'),
    ).toContain('data-nav-group={id}');
  });

  it('every data-tour value is on the element expected to carry it', () => {
    const carriers: Record<string, string> = {
      'week-strip': 'app/feed/page.tsx',
      'month-calendar': 'app/feed/page.tsx',
      'up-next': 'app/feed/page.tsx',
      'calendar-subscribe': 'app/feed/page.tsx',
      'you-card': 'app/feed/page.tsx',
      activity: 'app/feed/activity-panel.tsx',
      'next-session': 'app/sessions/session-card.tsx',
      'settings-chip': 'components/top-bar.tsx',
    };
    const named = targets.flatMap((t) => [...t.matchAll(/data-tour="([^"]+)"/g)].map((m) => m[1]!));
    for (const value of named) {
      const file = carriers[value];
      expect(file, `no carrier recorded for data-tour="${value}"`).toBeDefined();
      expect(src(file!), `${file} no longer carries ${value}`).toMatch(
        new RegExp(`data-tour=(?:"${value}"|\\{[^}]*'${value}')`),
      );
    }
  });
});
