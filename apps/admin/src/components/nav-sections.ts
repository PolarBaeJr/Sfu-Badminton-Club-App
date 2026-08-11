import {
  LayoutDashboard,
  Users,
  Trophy,
  Medal,
  Scale,
  ScrollText,
  Settings,
  Gauge,
  UserCog,
  Target,
  Calendar,
  DollarSign,
  Megaphone,
  ShieldCheck,
} from 'lucide-react';
import { canAccess, type AccessLevel, type Area, type Permissions } from '../lib/permissions';

// THE CONSOLE'S NAVIGATION, as data.
//
// Its own module, with no framework import, for one reason: it is the only
// hand-written list in the console with nothing tying it to the capability
// vocabulary, so it needs a test — and a test cannot import the sidebar, which
// pulls in next/navigation and a browser Supabase client.
//
// Two nav ROWS, not two access levels. Every item in both is filtered through
// canAccess() against the same section map the middleware uses, so this list
// can never offer a door that will not open — grouping is layout only.
//
// The first row is the day-to-day club work an exec does; the second is the
// back-office row, which happens to be mostly admin-only but is not uniformly
// so (/players and /settings reach down to trainers, /legal to execs). Put a
// section wherever it belongs on screen and let canAccess() do the deciding:
// hand-keeping a second idea of who may see what is exactly how execs came to
// be shown four links that bounced them to /unauthorized.
//
// EVERY ITEM NAMES THE AREA ITS HREF BELONGS TO, or null for the two links that
// belong to no area at all — the dashboard and settings, which every console
// user keeps regardless of what they hold. Until this key existed, a section
// renamed or an href mistyped would simply stop matching the section map,
// canAccess() would fall through to its admin-only default, and the link would
// disappear for every exec with nothing failing anywhere. The key's only job is
// to be checked against the vocabulary and against canAccess().
export type NavItem = {
  href: string;
  label: string;
  icon: typeof LayoutDashboard;
  area: Area | null;
};

export const NAV_SECTIONS: { title: string; items: NavItem[] }[] = [
  {
    title: 'Manage',
    items: [
      { href: '/dashboard', label: 'Dashboard', icon: LayoutDashboard, area: null },
      { href: '/matches', label: 'Matches', icon: Target, area: 'matches' },
      { href: '/tournaments', label: 'Tournaments', icon: Trophy, area: 'tournaments' },
      { href: '/sessions', label: 'Sessions', icon: Calendar, area: 'sessions' },
      { href: '/announcements', label: 'Announcements', icon: Megaphone, area: 'announcements' },
      { href: '/seasons', label: 'Seasons', icon: Medal, area: 'seasons' },
      // Route stays /fees — it is the section's access key in permissions.ts
      // and every existing link and revalidatePath points at it. The label is
      // "Finances" because the section is no longer only fees: other income and
      // expenses are tabs on the same page.
      //
      // Sits in the first row now that /fees is exec-level: for an exec it is
      // the only back-office link they have, and left in the second row it
      // would have rendered as a one-item strip under a divider. An exec who
      // follows it lands on the Expenses tab and sees nothing else — the page
      // decides that, not this list.
      { href: '/fees', label: 'Finances', icon: DollarSign, area: 'fees' },
    ],
  },
  {
    title: 'Admin only',
    items: [
      { href: '/players', label: 'Players', icon: Users, area: 'players' },
      { href: '/permissions', label: 'Permissions', icon: ShieldCheck, area: 'permissions' },
      // Platform configuration, split out of /settings — which stays trainer-level
      // for passkey enrolment and no longer carries any of it.
      { href: '/ratings', label: 'Ratings', icon: Gauge, area: 'ratings' },
      { href: '/accounts', label: 'Accounts', icon: UserCog, area: 'accounts' },
      { href: '/legal', label: 'Legal', icon: Scale, area: 'legal' },
      { href: '/audit', label: 'Audit Log', icon: ScrollText, area: 'audit' },
      { href: '/settings', label: 'Settings', icon: Settings, area: null },
    ],
  },
];

/**
 * Every door this person can actually open, flattened out of the two rows.
 *
 * Derived rather than listed, through the same canAccess() the sidebar and the
 * middleware use, so a section added to NAV_SECTIONS later appears here with no
 * second list to remember. The dashboard uses it to tell somebody narrowed by
 * permissions where they CAN go, instead of leaving them on a page whose every
 * panel belongs to a capability they do not hold.
 */
export function openableSections(
  level: AccessLevel | null,
  permissions: Permissions,
): NavItem[] {
  return NAV_SECTIONS.flatMap((section) => section.items).filter((item) =>
    canAccess(level, permissions, item.href),
  );
}
