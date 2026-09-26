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
    expect(ids(ctx())).toEqual(['welcome', 'calendar', 'next-session', 'tabs', 'membership', 'settings']);
  });

  it('drops the session step with sessions off', () => {
    expect(ids(ctx({ features: off('sessions') }))).toEqual(['welcome', 'calendar', 'tabs', 'membership', 'settings']);
  });

  it('shows the membership step only with fees and membership both on', () => {
    expect(ids(ctx({ features: off('fees') }))).not.toContain('membership');
    expect(ids(ctx({ features: off('membership') }))).not.toContain('membership');
  });

  it('drops the calendar only when sessions, events and tournaments are all off', () => {
    expect(ids(ctx({ features: off('sessions', 'events') }))).toContain('calendar');
    expect(ids(ctx({ features: off('sessions', 'events', 'tournaments') }))).not.toContain('calendar');
  });

  it('gives a pending signup no session step, only the Ranks tab, and no calendar feed', () => {
    const pending = ctx({ approved: false });
    expect(ids(pending)).toEqual(['welcome', 'calendar', 'tabs', 'settings']);
    expect(body(pending, 'tabs')).toBe('Ranks: your singles and doubles ladder.');
    expect(body(pending, 'settings')).not.toContain('calendar feed');
  });

  it('drops the tabs step for a pending signup with the leaderboard off', () => {
    expect(ids(ctx({ approved: false, features: off('leaderboard') }))).not.toContain('tabs');
  });

  it('names only the tabs this member can see', () => {
    expect(body(ctx({ features: off('challenges') }), 'tabs')).not.toContain('Challenges');
    expect(body(ctx({ features: off('tournaments', 'events') }), 'tabs')).not.toContain('Events');
    expect(body(ctx({ features: off('tournaments') }), 'tabs')).toContain('Events');
  });

  it('drops the tabs step when all four tab features are off', () => {
    expect(ids(ctx({ features: off('challenges', 'leaderboard', 'tournaments', 'events') }))).not.toContain('tabs');
  });

  it('keeps a switched-off tab for somebody who holds its key', () => {
    expect(body(ctx({ features: off('challenges'), featureAccess: ['challenges'] }), 'tabs')).toContain('Challenges:');
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
    'settings-chip': 'components/top-bar.tsx',
    'top-nav': 'components/top-bar.tsx',
    'tab-bar': 'components/bottom-nav.tsx',
    'membership-link': 'components/top-bar.tsx',
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
    const files = [...new Set(Object.values(carriers)), 'app/feed/activity-panel.tsx'];
    for (const file of files) {
      for (const m of src(file).matchAll(/data-tour="([^"]+)"/g)) {
        expect(named, `${file} carries data-tour="${m[1]}" and no step targets it`).toContain(m[1]);
      }
    }
    expect(src('components/top-bar.tsx')).not.toContain('data-tour-nav');
    expect(src('components/bottom-nav.tsx')).not.toContain('data-tour-nav');
  });
});
