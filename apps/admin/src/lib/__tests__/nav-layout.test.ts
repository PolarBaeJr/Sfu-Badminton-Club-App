import { describe, it, expect } from 'vitest';
import { NAV_LAYOUT, NAV_SECTIONS, type NavItem } from '../../components/nav-sections';
import {
  flattenEntries,
  isRouteActive,
  visibleEntries,
  type NavEntry,
} from '@badminton/ui/src/nav-groups';
import { canAccess, resolvePermissions, UNRESTRICTED, type AccessLevel, type Permissions } from '../permissions';

// THE TOP BAR IS A SECOND ARRANGEMENT OF THE SAME LIST, and these pin the two
// together. NAV_SECTIONS is what nav-drift.test.ts checks against the
// capability vocabulary; NAV_LAYOUT only moves its items into menus. So the
// layout must hold every one of those items exactly once, and what a person
// sees in it must be decided by the same canAccess() the sidebar calls.

const ITEMS = NAV_SECTIONS.flatMap((section) => section.items);

/** What the sidebar renders for this person, with the sidebar's own predicate. */
const visibleFor = (level: AccessLevel, permissions: Permissions) =>
  visibleEntries(NAV_LAYOUT, (item) => canAccess(level, permissions, item.href));

/** The layout reduced to something readable: a link's href, a group's id and hrefs. */
const shape = (entries: NavEntry<NavItem>[]) =>
  entries.map((entry) =>
    entry.kind === 'link'
      ? entry.item.href
      : { [entry.group.id]: entry.group.items.map((item) => item.href) },
  );

describe('the console top bar layout', () => {
  it('holds every NAV_SECTIONS item exactly once, and nothing else', () => {
    const hrefs = flattenEntries(NAV_LAYOUT).map((item) => item.href);
    expect(new Set(hrefs).size).toBe(hrefs.length);
    expect([...hrefs].sort()).toEqual(ITEMS.map((item) => item.href).sort());
  });

  it('reuses the NAV_SECTIONS item itself, so a label or area cannot drift', () => {
    for (const item of flattenEntries(NAV_LAYOUT)) {
      expect(ITEMS).toContain(item);
    }
  });

  it('gives every group a unique id', () => {
    const ids = NAV_LAYOUT.flatMap((entry) => (entry.kind === 'group' ? [entry.group.id] : []));
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('shows an admin every group, in full', () => {
    expect(visibleFor('admin', UNRESTRICTED)).toEqual(NAV_LAYOUT);
  });

  // The same ten links nav-drift.test.ts pins for an unrestricted exec, now in
  // menus. System holds only admin-only sections, so it is gone entirely.
  it('shows an unrestricted exec these menus', () => {
    const visible = visibleFor('exec', UNRESTRICTED);
    expect(shape(visible)).toEqual([
      '/dashboard',
      { play: ['/sessions', '/matches', '/seasons'] },
      { events: ['/tournaments'] },
      { members: ['/players'] },
      { club: ['/announcements', '/fees', '/legal'] },
      '/settings',
    ]);
    expect(flattenEntries(visible).map((item) => item.href).sort()).toEqual(
      ITEMS.filter((item) => canAccess('exec', UNRESTRICTED, item.href))
        .map((item) => item.href)
        .sort(),
    );
  });

  it('shows an unrestricted trainer only the roster menu and the two baseline links', () => {
    expect(shape(visibleFor('trainer', UNRESTRICTED))).toEqual([
      '/dashboard',
      { members: ['/players'] },
      '/settings',
    ]);
  });

  // A narrowed exec. A role alone no longer narrows (the level's baseline is a
  // floor under it, see dashboard-landing.test.ts), so this is the Finance role
  // with every other section page revoked by hand: Club becomes a menu of one
  // and every other group is gone.
  it('narrows a hand-revoked exec to the one menu they can still open', () => {
    const revokes = [
      'announcements.page', 'legal.page', 'matches.page', 'players.page',
      'seasons.page', 'sessions.page', 'tournaments.page',
    ];
    expect(shape(visibleFor('exec', resolvePermissions('exec', 'finance', [], revokes)))).toEqual([
      '/dashboard',
      { club: ['/fees'] },
      '/settings',
    ]);
  });
});

describe('isRouteActive', () => {
  it('matches the route itself and anything under it', () => {
    expect(isRouteActive('/tournaments', '/tournaments')).toBe(true);
    expect(isRouteActive('/tournaments/abc', '/tournaments')).toBe(true);
    expect(isRouteActive('/tournaments/abc/events/def', '/tournaments')).toBe(true);
  });

  it('does not match a route that only shares a prefix', () => {
    expect(isRouteActive('/eventsx', '/events')).toBe(false);
    expect(isRouteActive('/settingsx', '/settings')).toBe(false);
    expect(isRouteActive('/', '/events')).toBe(false);
  });

  it('matches the root only on the root', () => {
    expect(isRouteActive('/', '/')).toBe(true);
    expect(isRouteActive('/feed', '/')).toBe(false);
  });
});
