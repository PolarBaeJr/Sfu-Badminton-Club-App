import { describe, it, expect } from 'vitest';
import { flattenEntries, isGroupActive } from '@badminton/ui/src/nav-groups';
import {
  DESKTOP_ENTRIES,
  MOBILE_SLOTS,
  desktopEntries,
  mobileSlots,
  type PlayerNavEntry,
} from '../nav-entries';

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
