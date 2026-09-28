import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { selectSteps, resolveTarget, shouldAutoStart, type TourContext } from '@badminton/ui/src/tour';
import { ALL_FEATURES_ENABLED, type FeatureFlags } from '@badminton/shared/src/utils/features';
import { MEMBER_TOUR_KEY, memberTourSteps } from '../tours/member-tour';

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

const selected = (c: TourContext) => selectSteps(memberTourSteps(c), c);
const ids = (c: TourContext) => selected(c).map((s) => s.id);
const body = (c: TourContext, id: string) => selected(c).find((s) => s.id === id)?.body ?? '';

describe('the member tour steps', () => {
  it('has six steps with every feature on', () => {
    expect(ids(ctx())).toEqual(['welcome', 'calendar', 'next-session', 'challenges', 'membership', 'settings']);
  });

  it('drops the session step with sessions off', () => {
    expect(ids(ctx({ features: off('sessions') }))).toEqual(['welcome', 'calendar', 'challenges', 'membership', 'settings']);
  });

  it('shows the membership step only with fees and membership both on', () => {
    expect(ids(ctx({ features: off('fees') }))).not.toContain('membership');
    expect(ids(ctx({ features: off('membership') }))).not.toContain('membership');
  });

  it('drops the calendar only when sessions, events and tournaments are all off', () => {
    expect(ids(ctx({ features: off('sessions', 'events') }))).toContain('calendar');
    expect(ids(ctx({ features: off('sessions', 'events', 'tournaments') }))).not.toContain('calendar');
  });

  it('gives a pending signup no session, challenge or fees step, and no calendar feed', () => {
    const pending = ctx({ approved: false });
    expect(ids(pending)).toEqual(['welcome', 'calendar', 'settings']);
    expect(body(pending, 'settings')).not.toContain('calendar feed');
  });

  it('drops the challenge step with challenges off, and keeps it for a key holder', () => {
    expect(ids(ctx({ features: off('challenges') }))).not.toContain('challenges');
    expect(ids(ctx({ features: off('challenges'), featureAccess: ['challenges'] }))).toContain('challenges');
  });

  it('names events and tournaments on the calendar step', () => {
    expect(body(ctx(), 'calendar')).toMatch(/events and tournaments/);
  });

  it('always keeps the two cards', () => {
    const everythingOff = off(
      'sessions', 'challenges', 'tournaments', 'events', 'leaderboard', 'my_stats', 'announcements', 'fees',
    );
    expect(ids(ctx({ features: everythingOff, approved: false }))).toEqual(['welcome', 'settings']);
  });

  it('uses the member key', () => {
    expect(MEMBER_TOUR_KEY).toBe('member_v1');
  });

  it('visits only the feed, Challenges, Membership and Settings', () => {
    const hrefs = memberTourSteps(ctx()).flatMap((s) => (s.href ? [s.href] : []));
    expect(hrefs).toContain('/membership');
    for (const href of hrefs) expect(['/feed', '/challenges', '/membership', '/settings'], href).toContain(href);
  });

  it('starts the welcome card where the tour opens, and every later step names its page', () => {
    const [first, ...rest] = memberTourSteps(ctx());
    expect(first!.href).toBeUndefined();
    for (const step of rest) expect(step.href, step.id).toBeDefined();
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
  const targets = memberTourSteps(ctx()).flatMap((s) => s.targets);
  const named = targets.flatMap((t) => [...t.matchAll(/data-tour="([^"]+)"/g)].map((m) => m[1]!));
  const carriers: Record<string, string> = {
    'week-strip': 'app/feed/page.tsx',
    'month-calendar': 'app/feed/page.tsx',
    'up-next': 'app/feed/page.tsx',
    'next-session': 'app/sessions/session-card.tsx',
    'new-challenge': 'app/challenges/page.tsx',
    'membership-statement': 'app/membership/member-section.tsx',
    'settings-notifications': 'app/settings/page.tsx',
  };

  it('every data-tour value is on the element expected to carry it', () => {
    for (const value of named) {
      const file = carriers[value];
      expect(file, `no carrier recorded for data-tour="${value}"`).toBeDefined();
      expect(src(file!), `${file} no longer carries ${value}`).toMatch(
        new RegExp(`data-tour=(?:"${value}"|\\{[^}]*'${value}')`),
      );
    }
  });

  // The other direction: an anchor no step points at is dead markup, and the
  // next reader will assume something depends on it.
  it('every data-tour anchor in these files is targeted by a step', () => {
    const files = [
      ...new Set(Object.values(carriers)),
      'app/feed/activity-panel.tsx',
      'components/top-bar.tsx',
      'components/bottom-nav.tsx',
    ];
    for (const file of files) {
      for (const m of src(file).matchAll(/data-tour="([^"]+)"/g)) {
        expect(named, `${file} carries data-tour="${m[1]}" and no step targets it`).toContain(m[1]);
      }
    }
    expect(src('components/top-bar.tsx')).not.toContain('data-tour-nav');
    expect(src('components/bottom-nav.tsx')).not.toContain('data-tour-nav');
  });
});
