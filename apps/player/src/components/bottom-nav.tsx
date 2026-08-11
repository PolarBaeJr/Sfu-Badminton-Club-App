'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useState, useEffect } from 'react';
import { cn } from '@badminton/ui';
import { createClient } from '@/lib/supabase-browser';
import {
  ANNOUNCEMENT_VISIBILITY_COLUMNS,
  addressedTo,
  unreadAnnouncementCount,
  withVisibleAnnouncements,
} from '@/lib/announcement-visibility';
import { Home, Trophy, Crosshair, Calendar, Sparkles, LogIn } from 'lucide-react';

// `gated` = needs an approved account (see top-bar.tsx).
const navItems = [
  { href: '/feed',        label: 'Feed',  icon: Home,      gated: false },
  { href: '/leaderboard', label: 'Ranks', icon: Trophy,    gated: false },
  { href: '/challenges',  label: 'Vs.',   icon: Crosshair, gated: true  },
  { href: '/sessions',    label: 'Play',  icon: Calendar,  gated: true  },
  { href: '/my-stats',    label: 'Me',    icon: Sparkles,  gated: false },
];

const publicNavItems = [
  { href: '/',            label: 'Home',    icon: Home  },
  { href: '/leaderboard', label: 'Ranks',   icon: Trophy },
  { href: '/login',       label: 'Sign in', icon: LogIn },
];

export function BottomNav({
  isAuthenticated,
  isApproved = true,
}: {
  isAuthenticated: boolean;
  /** False while the account is pending approval or suspended. */
  isApproved?: boolean;
}) {
  const pathname = usePathname();
  const [unreadAnnouncements, setUnreadAnnouncements] = useState(0);

  useEffect(() => {
    const supabase = createClient();

    // THE BADGE COUNTS WHAT /announcements WOULD ACTUALLY SHOW.
    //
    // It used to be count(all published) − count(my reads), with no expiry,
    // audience or season filter on either side. That is wrong in both
    // directions at once. A published post this member can never see — expired,
    // addressed to the other division, retired with last term's season — is in
    // the first number and can never reach the second, so it inflates the badge
    // forever; after a rollover the tab sat on a red dot with nothing behind it
    // to click. And a read row for a post that has since retired is in the
    // second number and not the first, so it can hide a post that IS unread.
    //
    // So: fetch the ids this member can see, fetch the ids they have read, and
    // take the difference. Ids rather than counts is the whole fix — two counts
    // taken over different populations cannot be subtracted, however they are
    // clamped.
    //
    // This matters more since the redesign dropped the per-row NEW tag: the
    // badge is now the only unread signal there is.
    async function checkUnread() {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) return;
      const { data: player } = await supabase
        .from('players')
        // status and eligibility_flag because target_audience is matched
        // against the viewer, not filtered in the query.
        .select('id, status, eligibility_flag')
        .eq('user_id', user.id)
        .maybeSingle();
      if (!player) return;

      const { data: activeSeason } = await supabase
        .from('seasons')
        .select('id')
        .eq('active_flag', true)
        .maybeSingle();

      const [{ data: visible }, { data: reads }] = await Promise.all([
        withVisibleAnnouncements(
          supabase
            .from('announcements')
            .select(ANNOUNCEMENT_VISIBILITY_COLUMNS)
            .eq('status', 'published'),
          new Date().toISOString(),
          activeSeason?.id,
        ),
        supabase.from('announcement_reads').select('announcement_id').eq('player_id', player.id),
      ]);

      setUnreadAnnouncements(
        unreadAnnouncementCount(
          addressedTo(visible ?? [], player).map((a) => a.id),
          (reads ?? []).map((r) => r.announcement_id as string),
        ),
      );
    }

    checkUnread();

    const channel = supabase
      .channel('announcements-nav')
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'announcements' }, () => {
        checkUnread();
      })
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, []);

  // Auth / onboarding screens render their own full-screen layout — no app chrome.
  if (pathname === '/login' || pathname.startsWith('/auth') || pathname === '/onboarding') {
    return null;
  }

  const items = isAuthenticated
    ? navItems.filter((item) => isApproved || !item.gated)
    : publicNavItems;

  return (
    <nav className="mobile-tabbar" aria-label="Mobile navigation">
      {items.map((item) => {
        const active = item.href === '/' ? pathname === '/' : pathname.startsWith(item.href);
        const isLeaderboard = item.href === '/leaderboard';
        const showBadge = item.href === '/feed' && unreadAnnouncements > 0;
        return (
          <Link
            key={item.href}
            href={item.href}
            className={cn('press', active && 'active')}
            aria-current={active ? 'page' : undefined}
          >
            <item.icon
              size={20}
              className={cn(
                active && isLeaderboard && 'icon-trophy-shimmer',
              )}
            />
            <span>{item.label}</span>
            {showBadge && (
              <span
                aria-label={`${unreadAnnouncements} unread announcements`}
                style={{
                  position: 'absolute',
                  top: 6,
                  right: '38%',
                  minWidth: 14,
                  height: 14,
                  padding: '0 4px',
                  borderRadius: 999,
                  background: 'var(--red)',
                  color: '#fff',
                  fontSize: 9,
                  fontWeight: 700,
                  display: 'inline-flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                {unreadAnnouncements > 9 ? '9+' : unreadAnnouncements}
              </span>
            )}
          </Link>
        );
      })}
    </nav>
  );
}
