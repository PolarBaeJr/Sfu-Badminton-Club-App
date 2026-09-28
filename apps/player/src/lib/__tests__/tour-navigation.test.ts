import { describe, it, expect } from 'vitest';
import {
  TOUR_NAV_TIMEOUT_MS,
  TOUR_TARGET_TIMEOUT_MS,
  effectiveRoutes,
  pathMatches,
  routeDecision,
  skipTo,
  stripBasePath,
  targetDecision,
  type TourStep,
} from '@badminton/ui/src/tour';

// HOW THE TOUR GETS FROM PAGE TO PAGE, as the pure decisions the component
// makes. Nothing here drives a router; whether a real navigation lands where
// these say is for a browser.

const step = (id: string, href?: string): TourStep => ({ id, title: id, body: id, targets: [], missingTarget: 'center', href });

describe('stripBasePath', () => {
  it('removes the base path', () => {
    expect(stripBasePath('/admin/players', '/admin')).toBe('/players');
    expect(stripBasePath('/admin', '/admin')).toBe('/');
    expect(stripBasePath('/admin/', '/admin')).toBe('/');
  });

  it('removes it only as a whole segment', () => {
    expect(stripBasePath('/administer', '/admin')).toBe('/administer');
  });

  it('drops the query, the hash and a trailing slash', () => {
    expect(stripBasePath('/players/?tab=all#top', '')).toBe('/players');
    expect(stripBasePath('/dashboard?tour=exec', '/admin')).toBe('/dashboard');
    expect(stripBasePath('', '')).toBe('/');
  });
});

describe('pathMatches', () => {
  it('matches the same path', () => {
    expect(pathMatches('/players', '/players')).toBe(true);
    expect(pathMatches('/players', '/sessions')).toBe(false);
  });

  it('matches with the base path on either side', () => {
    expect(pathMatches('/admin/players', '/players', '/admin')).toBe(true);
    expect(pathMatches('/players', '/admin/players', '/admin')).toBe(true);
  });

  it('takes any one segment for a [param]', () => {
    expect(pathMatches('/events/abc-123', '/events/[id]')).toBe(true);
    expect(pathMatches('/events', '/events/[id]')).toBe(false);
    expect(pathMatches('/events/abc/edit', '/events/[id]')).toBe(false);
  });

  it('needs the same number of segments, and whole segments', () => {
    expect(pathMatches('/legal/guests', '/legal')).toBe(false);
    expect(pathMatches('/eventsx', '/events')).toBe(false);
  });
});

describe('effectiveRoutes', () => {
  it('inherits the page of the step before, and starts where the tour opened', () => {
    const steps = [step('welcome'), step('a', '/sessions'), step('b'), step('c', '/players'), step('done')];
    expect(effectiveRoutes(steps, '/dashboard')).toEqual(['/dashboard', '/sessions', '/sessions', '/players', '/players']);
  });
});

describe('routeDecision', () => {
  const base = { route: '/players', basePath: '', timeoutMs: TOUR_NAV_TIMEOUT_MS };
  const nav = (over: Partial<{ fromPath: string; arrived: boolean; elapsedMs: number }> = {}) => ({
    fromPath: '/dashboard',
    arrived: false,
    elapsedMs: 100,
    ...over,
  });

  it('is ready on the page', () => {
    expect(routeDecision({ ...base, pathname: '/players', nav: null })).toBe('ready');
    expect(routeDecision({ ...base, pathname: '/admin/players', basePath: '/admin', nav: nav() })).toBe('ready');
  });

  it('navigates when it has not asked yet', () => {
    expect(routeDecision({ ...base, pathname: '/dashboard', nav: null })).toBe('navigate');
  });

  it('waits while the page is loading', () => {
    expect(routeDecision({ ...base, pathname: '/dashboard', nav: nav() })).toBe('wait');
  });

  it('skips once the time limit passes', () => {
    expect(routeDecision({ ...base, pathname: '/dashboard', nav: nav({ elapsedMs: TOUR_NAV_TIMEOUT_MS }) })).toBe('skip');
  });

  it('skips when it landed somewhere else', () => {
    expect(routeDecision({ ...base, pathname: '/unauthorized', nav: nav() })).toBe('skip');
  });

  it('skips when it arrived and was then redirected', () => {
    expect(routeDecision({ ...base, route: '/membership', pathname: '/feed', nav: nav({ fromPath: '/settings', arrived: true }) })).toBe('skip');
  });

  // Redirected back to the page it came from: the path never changes, so only
  // the time limit can tell.
  it('times out a redirect back to where it started', () => {
    const back = { ...base, route: '/membership', pathname: '/feed' };
    expect(routeDecision({ ...back, nav: nav({ fromPath: '/feed', elapsedMs: 500 }) })).toBe('wait');
    expect(routeDecision({ ...back, nav: nav({ fromPath: '/feed', elapsedMs: TOUR_NAV_TIMEOUT_MS }) })).toBe('skip');
  });
});

describe('targetDecision', () => {
  const base = { hasTargets: true, found: false, elapsedMs: 0, timeoutMs: TOUR_TARGET_TIMEOUT_MS, missingTarget: 'skip' as const };

  it('is a card at once for a step with nothing to point at', () => {
    expect(targetDecision({ ...base, hasTargets: false })).toBe('center');
  });

  it('points at a target it found', () => {
    expect(targetDecision({ ...base, found: true })).toBe('found');
  });

  it('waits for a target, then does what the step says', () => {
    expect(targetDecision(base)).toBe('wait');
    expect(targetDecision({ ...base, elapsedMs: TOUR_TARGET_TIMEOUT_MS })).toBe('skip');
    expect(targetDecision({ ...base, elapsedMs: TOUR_TARGET_TIMEOUT_MS, missingTarget: 'center' })).toBe('center');
  });
});

describe('skipTo', () => {
  it('moves on in the same direction', () => {
    expect(skipTo({ index: 2, direction: 1, length: 5, backOrigin: null })).toEqual({ index: 3, direction: 1 });
    expect(skipTo({ index: 2, direction: -1, length: 5, backOrigin: 3 })).toEqual({ index: 1, direction: -1 });
  });

  it('finishes past the end', () => {
    expect(skipTo({ index: 4, direction: 1, length: 5, backOrigin: null })).toBe('finish');
  });

  it('goes forward from the step Back was pressed on, past the front', () => {
    expect(skipTo({ index: 0, direction: -1, length: 5, backOrigin: 3 })).toEqual({ index: 3, direction: 1 });
  });
});
