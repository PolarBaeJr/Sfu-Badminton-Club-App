import { describe, it, expect } from 'vitest';
import { flattenEntries, isGroupActive } from '@badminton/ui/src/nav-groups';
import {
  DESKTOP_ENTRIES,
  MOBILE_SLOTS,
  desktopEntries,
  mobileSlots,
  type PlayerNavEntry,
} from '../nav-entries';
import { ALL_FEATURES_ENABLED, FEATURES, type FeatureFlags } from '@badminton/shared/src/utils/features';

// WHO SEES WHICH MENU. A pending member is refused by requirePlayer() on every
// gated route, so Challenges and Events hold nothing they can open and must
// not render at all, on either bar.

const labels = (entries: PlayerNavEntry[]) =>
  entries.map((entry) => (entry.kind === 'link' ? entry.item.label : entry.group.label));

const groupIds = (entries: PlayerNavEntry[]) =>
  entries.flatMap((entry) => (entry.kind === 'group' ? [entry.group.id] : []));

describe('the player top bar', () => {
  it('shows an approved member every entry', () => {
    expect(desktopEntries(true)).toEqual(DESKTOP_ENTRIES);
    expect(labels(desktopEntries(true))).toEqual(['Feed', 'Challenges', 'Events', 'Stats', 'Membership']);
  });

  it('shows a pending member no Challenges and no Events', () => {
    const entries = desktopEntries(false);
    expect(groupIds(entries)).toEqual(['stats']);
    expect(labels(entries)).toEqual(['Feed', 'Stats', 'Membership']);
    expect(flattenEntries(entries).some((item) => item.gated)).toBe(false);
  });

  it('puts tournaments and club events under Events', () => {
    const events = DESKTOP_ENTRIES.find((e) => e.kind === 'group' && e.group.id === 'events');
    expect(events?.kind === 'group' && events.group.items.map((item) => item.href)).toEqual(['/tournaments', '/events']);
  });

  it('never lists one destination twice', () => {
    const hrefs = flattenEntries(DESKTOP_ENTRIES).map((item) => item.href);
    expect(new Set(hrefs).size).toBe(hrefs.length);
  });
});

describe('the mobile tab bar', () => {
  it('has five slots for an approved member', () => {
    expect(mobileSlots(true)).toHaveLength(5);
    expect(labels(mobileSlots(true))).toEqual(['Feed', 'Ranks', 'Challenges', 'Events', 'Me']);
  });

  it('has three for a pending member: Feed, Ranks and Me', () => {
    expect(labels(mobileSlots(false))).toEqual(['Feed', 'Ranks', 'Me']);
  });

  // Every destination the top bar offers is reachable from the tab bar too,
  // except /membership: five slots is what fits, and a member on a phone
  // reaches it from Settings instead.
  it('reaches every top bar destination', () => {
    const mobile = flattenEntries(MOBILE_SLOTS).map((item) => item.href).sort();
    const desktop = flattenEntries(DESKTOP_ENTRIES)
      .map((item) => item.href)
      .filter((href) => href !== '/membership')
      .sort();
    expect(mobile).toEqual(desktop);
  });

  // The schedule is the feed; /sessions only redirects there.
  it('lists no /sessions destination on either bar', () => {
    for (const entries of [DESKTOP_ENTRIES, MOBILE_SLOTS]) {
      expect(flattenEntries(entries).some((item) => item.href.startsWith('/sessions'))).toBe(false);
    }
  });

  it('lights Events on a tournament page and not on the feed', () => {
    const events = MOBILE_SLOTS.find((e) => e.kind === 'group' && e.group.id === 'events');
    if (events?.kind !== 'group') throw new Error('no Events slot');
    expect(isGroupActive('/tournaments/abc', events.group)).toBe(true);
    expect(isGroupActive('/feed', events.group)).toBe(false);
  });
});

// A CLUB FEATURE SWITCHED OFF IS HIDDEN FROM MEMBERS on both bars, and a menu
// or slot it leaves empty goes with it. Anyone with console access keeps it,
// because they can still open its pages.
describe('the nav with a feature switched off', () => {
  const off = (...ids: (keyof FeatureFlags)[]): FeatureFlags => ({
    ...ALL_FEATURES_ENABLED,
    ...Object.fromEntries(ids.map((id) => [id, false])),
  });
  const hrefs = (entries: PlayerNavEntry[]) => flattenEntries(entries).map((item) => item.href);

  it('changes nothing while every feature is on', () => {
    expect(desktopEntries(true, ALL_FEATURES_ENABLED)).toEqual(DESKTOP_ENTRIES);
    expect(mobileSlots(true, ALL_FEATURES_ENABLED)).toEqual(MOBILE_SLOTS);
  });

  it('drops the Events menu on both bars when tournaments and club events are off', () => {
    expect(labels(desktopEntries(true, off('tournaments', 'events')))).toEqual(['Feed', 'Challenges', 'Stats', 'Membership']);
    expect(labels(mobileSlots(true, off('tournaments', 'events')))).toEqual(['Feed', 'Ranks', 'Challenges', 'Me']);
  });

  it('keeps Events with only club events in it when tournaments alone are off', () => {
    expect(labels(desktopEntries(true, off('tournaments')))).toEqual(['Feed', 'Challenges', 'Events', 'Stats', 'Membership']);
    expect(hrefs(desktopEntries(true, off('tournaments')))).not.toContain('/tournaments');
    expect(hrefs(desktopEntries(true, off('tournaments')))).toContain('/events');
  });

  it('keeps Events for a holder of page.access.tournaments, who can still open the pages', () => {
    expect(labels(desktopEntries(true, off('tournaments', 'events'), ['tournaments']))).toEqual(['Feed', 'Challenges', 'Events', 'Stats', 'Membership']);
    expect(labels(mobileSlots(true, off('tournaments', 'events'), ['tournaments']))).toEqual(['Feed', 'Ranks', 'Challenges', 'Events', 'Me']);
  });

  // THE KEY IS PER FEATURE. Holding the one for challenges is not a way into
  // tournaments, which is what "console access" used to be.
  it('drops Events for a holder of a different feature key', () => {
    expect(labels(desktopEntries(true, off('tournaments', 'events'), ['challenges']))).toEqual(['Feed', 'Challenges', 'Stats', 'Membership']);
  });

  it('drops a mobile slot whose only destination is off', () => {
    expect(labels(mobileSlots(true, off('leaderboard')))).toEqual(['Feed', 'Challenges', 'Events', 'Me']);
    expect(labels(mobileSlots(true, off('my_stats')))).toEqual(['Feed', 'Ranks', 'Challenges', 'Events']);
  });

  it('changes nothing when sessions are off, since no entry leads to them', () => {
    expect(desktopEntries(true, off('sessions'))).toEqual(DESKTOP_ENTRIES);
    expect(mobileSlots(true, off('sessions'))).toEqual(MOBILE_SLOTS);
  });

  it('drops the Challenges link when challenges are off', () => {
    expect(labels(desktopEntries(true, off('challenges')))).toEqual(['Feed', 'Events', 'Stats', 'Membership']);
    expect(labels(mobileSlots(true, off('challenges')))).toEqual(['Feed', 'Ranks', 'Events', 'Me']);
  });

  it('shrinks a menu rather than dropping it while something in it is still on', () => {
    expect(hrefs(desktopEntries(true, off('leaderboard')))).not.toContain('/leaderboard');
    expect(labels(desktopEntries(true, off('leaderboard')))).toEqual(['Feed', 'Challenges', 'Events', 'Stats', 'Membership']);
  });

  it('hides every switchable destination, and only those, when all are off', () => {
    const allOff = off(...FEATURES.map((f) => f.id));
    expect(hrefs(desktopEntries(true, allOff))).toEqual(['/feed']);
    expect(hrefs(mobileSlots(true, allOff))).toEqual(['/feed']);
  });

  // Its own switch, not the fees one: /fees is the statement, /membership the
  // public page.
  it('drops Membership when the membership switch is off, and only then', () => {
    expect(hrefs(desktopEntries(true, off('membership')))).not.toContain('/membership');
    expect(hrefs(desktopEntries(true, off('fees')))).toContain('/membership');
    expect(hrefs(desktopEntries(true, off('membership'), ['membership']))).toContain('/membership');
  });

  it('still hides gated items from a pending member when a feature is on', () => {
    expect(groupIds(desktopEntries(false, off('leaderboard')))).toEqual(['stats']);
  });
});
