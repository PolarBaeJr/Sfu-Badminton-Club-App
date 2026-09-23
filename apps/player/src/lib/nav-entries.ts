import { Home, Trophy, Crosshair, Calendar, Award, Sparkles, type LucideIcon } from 'lucide-react';
// Deep, NOT the '@badminton/ui' barrel: that loads every component in the
// package, and this module is imported by a test that has no DOM.
import { visibleEntries, type NavEntry, type NavGroup } from '@badminton/ui/src/nav-groups';
// Deep for the same reason: the feature registry has no imports of its own.
import {
  ALL_FEATURES_ENABLED,
  playerPathVisible,
  type FeatureFlags,
} from '@badminton/shared/src/utils/features';

// THE SIGNED-IN NAV, as data, shared by the top bar and the mobile tab bar so
// the two cannot disagree about what is in a group or who may see it. Its own
// module so a test can import it: the components pull in next/navigation.
//
// `gated` marks destinations that require an approved account. requirePlayer()
// rejects a pending member with "Account pending approval", so linking them is
// a promise the app can't keep: hide until approved rather than let someone
// click through to an error.
export type PlayerNavItem = {
  href: string;
  label: string;
  icon: LucideIcon;
  gated: boolean;
};

export type PlayerNavEntry = NavEntry<PlayerNavItem, LucideIcon>;

const FEED: PlayerNavItem = { href: '/feed', label: 'Feed', icon: Home, gated: false };
const LEADERBOARD: PlayerNavItem = { href: '/leaderboard', label: 'Leaderboard', icon: Trophy, gated: false };
const SCHEDULE: PlayerNavItem = { href: '/sessions', label: 'Schedule', icon: Calendar, gated: true };
const CHALLENGES: PlayerNavItem = { href: '/challenges', label: 'Challenges', icon: Crosshair, gated: true };
const TOURNAMENTS: PlayerNavItem = { href: '/tournaments', label: 'Tournaments', icon: Award, gated: true };
const MY_STATS: PlayerNavItem = { href: '/my-stats', label: 'My stats', icon: Sparkles, gated: false };

const PLAY: NavGroup<PlayerNavItem, LucideIcon> = {
  id: 'play',
  label: 'Play',
  icon: Calendar,
  items: [SCHEDULE, CHALLENGES],
};

// A new kind of club event is one more item here.
const EVENTS: NavGroup<PlayerNavItem, LucideIcon> = {
  id: 'events',
  label: 'Events',
  icon: Award,
  items: [TOURNAMENTS],
};

const STATS: NavGroup<PlayerNavItem, LucideIcon> = {
  id: 'stats',
  label: 'Stats',
  icon: Sparkles,
  items: [LEADERBOARD, MY_STATS],
};

export const DESKTOP_ENTRIES: PlayerNavEntry[] = [
  { kind: 'link', item: FEED },
  { kind: 'group', group: PLAY },
  { kind: 'group', group: EVENTS },
  { kind: 'group', group: STATS },
];

// Five slots is what fits under a thumb. Ranks and Me stay direct links, with
// the short labels the tab bar has always used; Play and Events open a sheet.
export const MOBILE_SLOTS: PlayerNavEntry[] = [
  { kind: 'link', item: FEED },
  { kind: 'link', item: { ...LEADERBOARD, label: 'Ranks' } },
  { kind: 'group', group: PLAY },
  { kind: 'group', group: EVENTS },
  { kind: 'link', item: { ...MY_STATS, label: 'Me' } },
];

// A club feature that is switched off is hidden too, unless the viewer holds a
// console level: they can still open its pages (under a banner), so the nav
// still takes them there. A slot whose only destination is hidden goes with it.
const allowedFor =
  (isApproved: boolean, features: FeatureFlags, isExec: boolean) => (item: PlayerNavItem) =>
    (isApproved || !item.gated) && playerPathVisible(item.href, features, isExec);

export function desktopEntries(
  isApproved: boolean,
  features: FeatureFlags = ALL_FEATURES_ENABLED,
  isExec = false,
): PlayerNavEntry[] {
  return visibleEntries(DESKTOP_ENTRIES, allowedFor(isApproved, features, isExec));
}

export function mobileSlots(
  isApproved: boolean,
  features: FeatureFlags = ALL_FEATURES_ENABLED,
  isExec = false,
): PlayerNavEntry[] {
  return visibleEntries(MOBILE_SLOTS, allowedFor(isApproved, features, isExec));
}
