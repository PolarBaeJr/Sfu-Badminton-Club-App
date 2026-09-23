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
// gated route, so Play and Events hold nothing they can open and must not
// render at all, on either bar.

const labels = (entries: PlayerNavEntry[]) =>
  entries.map((entry) => (entry.kind === 'link' ? entry.item.label : entry.group.label));

const groupIds = (entries: PlayerNavEntry[]) =>
  entries.flatMap((entry) => (entry.kind === 'group' ? [entry.group.id] : []));

describe('the player top bar', () => {
  it('shows an approved member every entry', () => {
    expect(desktopEntries(true)).toEqual(DESKTOP_ENTRIES);
    expect(labels(desktopEntries(true))).toEqual(['Feed', 'Play', 'Events', 'Stats']);
  });

  it('shows a pending member no Play and no Events', () => {
    const entries = desktopEntries(false);
    expect(groupIds(entries)).toEqual(['stats']);
    expect(flattenEntries(entries).some((item) => item.gated)).toBe(false);
  });

  it('puts tournaments under Events', () => {
    const events = DESKTOP_ENTRIES.find((e) => e.kind === 'group' && e.group.id === 'events');
    expect(events?.kind === 'group' && events.group.items.map((item) => item.href)).toEqual(['/tournaments']);
  });

  it('never lists one destination twice', () => {
    const hrefs = flattenEntries(DESKTOP_ENTRIES).map((item) => item.href);
    expect(new Set(hrefs).size).toBe(hrefs.length);
  });
});

describe('the mobile tab bar', () => {
  it('has five slots for an approved member', () => {
    expect(mobileSlots(true)).toHaveLength(5);
    expect(labels(mobileSlots(true))).toEqual(['Feed', 'Ranks', 'Play', 'Events', 'Me']);
  });

  it('has three for a pending member: Feed, Ranks and Me', () => {
    expect(labels(mobileSlots(false))).toEqual(['Feed', 'Ranks', 'Me']);
  });

  // Every destination the top bar offers is reachable from the tab bar too.
  it('reaches every top bar destination', () => {
    const mobile = flattenEntries(MOBILE_SLOTS).map((item) => item.href).sort();
    const desktop = flattenEntries(DESKTOP_ENTRIES).map((item) => item.href).sort();
    expect(mobile).toEqual(desktop);
  });

  it('lights Play on a session page and not on a tournament', () => {
    const play = MOBILE_SLOTS.find((e) => e.kind === 'group' && e.group.id === 'play');
    if (play?.kind !== 'group') throw new Error('no Play slot');
    expect(isGroupActive('/sessions/abc', play.group)).toBe(true);
    expect(isGroupActive('/tournaments/abc', play.group)).toBe(false);
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

  it('drops the Events menu on both bars when tournaments are off', () => {
    expect(labels(desktopEntries(true, off('tournaments')))).toEqual(['Feed', 'Play', 'Stats']);
    expect(labels(mobileSlots(true, off('tournaments')))).toEqual(['Feed', 'Ranks', 'Play', 'Me']);
  });

  it('keeps Events for a console holder, who can still open the pages', () => {
    expect(labels(desktopEntries(true, off('tournaments'), true))).toEqual(['Feed', 'Play', 'Events', 'Stats']);
    expect(labels(mobileSlots(true, off('tournaments'), true))).toEqual(['Feed', 'Ranks', 'Play', 'Events', 'Me']);
  });

  it('drops a mobile slot whose only destination is off', () => {
    expect(labels(mobileSlots(true, off('leaderboard')))).toEqual(['Feed', 'Play', 'Events', 'Me']);
    expect(labels(mobileSlots(true, off('my_stats')))).toEqual(['Feed', 'Ranks', 'Play', 'Events']);
  });

  it('shrinks a menu rather than dropping it while something in it is still on', () => {
    expect(hrefs(desktopEntries(true, off('sessions')))).not.toContain('/sessions');
    expect(labels(desktopEntries(true, off('sessions')))).toEqual(['Feed', 'Play', 'Events', 'Stats']);
    expect(labels(desktopEntries(true, off('sessions', 'challenges')))).toEqual(['Feed', 'Events', 'Stats']);
  });

  it('hides every switchable destination, and only those, when all are off', () => {
    const allOff = off(...FEATURES.map((f) => f.id));
    expect(hrefs(desktopEntries(true, allOff))).toEqual(['/feed']);
    expect(hrefs(mobileSlots(true, allOff))).toEqual(['/feed']);
  });

  it('still hides gated items from a pending member when a feature is on', () => {
    expect(groupIds(desktopEntries(false, off('leaderboard')))).toEqual(['stats']);
  });
});
