'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { cn, useLiveChannel } from '@badminton/ui';
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
  /** The viewer's players.id, once resolved. Null while signed out. */
  const [playerId, setPlayerId] = useState<string | null>(null);

  // ONE CLIENT FOR THE LIFE OF THE NAV. This component sits in the layout and
  // never unmounts, and the count is re-read on every navigation now — a client
  // built inside that effect would be a new one per route change, each with its
  // own auth listener and its own socket.
  const supabase = useMemo(() => createClient(), []);

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
  const checkUnread = useCallback(async () => {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return;
    // players_self, NOT players. This runs in the browser as `authenticated`,
    // and 00032 replaced blanket SELECT on `players` with a column grant that
    // does not include `eligibility_flag` — so this query was refused outright
    // ("permission denied for table players"), and because a refusal arrives as
    // `data: null` rather than a rejection, the badge simply never appeared.
    // Live on production from the 2026-08-15 deploy until now; Sentry caught it
    // with the query in the breadcrumb, which is the only reason it was found.
    //
    // The view is already scoped to the caller's own row and `authenticated`
    // holds table-level SELECT on it, so this reads the column without widening
    // anyone's access to anyone else's. The .eq() is kept as belt-and-braces:
    // the view enforces it, and a filter that agrees with the view costs one
    // index lookup and survives the view being redefined.
    const { data: player } = await supabase
      .from('players_self')
      // status and eligibility_flag because target_audience is matched
      // against the viewer, not filtered in the query.
      .select('id, status, eligibility_flag')
      .eq('user_id', user.id)
      .maybeSingle();
    if (!player) return;
    // Kept in state rather than returned: it is what the reads subscription
    // filters on, and resolving it there as well would be the same two queries
    // a second time on every mount.
    setPlayerId(player.id as string);

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
  }, [supabase]);

  // RE-READ ON LEAVING /announcements, and this is the half that works today.
  //
  // The nav lives in the layout and never remounts, so the count was read once
  // per full page load and after that only when somebody PUBLISHED. A member
  // who read every post kept the badge until the next announcement went out:
  // the read rows are written by their own device, and nothing told the nav.
  //
  // Posts are marked read as they scroll into view on /announcements — that is
  // the only screen in the app that writes a read row — so leaving it is
  // exactly the moment the answer has changed, and the only moment a
  // navigation can tell. Refetching on EVERY route change would be five
  // queries per tab tap on a phone for an answer that had not moved.
  //
  // Needs no realtime and no migration, which is why it is here as well as
  // below.
  const previousPath = useRef(pathname);
  useEffect(() => {
    const left = previousPath.current;
    previousPath.current = pathname;
    // The first run is the mount, where `left === pathname` and the count has
    // to be read whatever the route is.
    if (left !== pathname && !left.startsWith('/announcements')) return;
    void checkUnread();
  }, [checkUnread, pathname]);

  // THE SAME QUESTION ASKED FROM THE SERVER'S SIDE, for the cases a navigation
  // cannot see: a post published while the member sits on one screen, and a
  // read that lands from their other device.
  //
  // Nothing is subscribed until the viewer is resolved. A signed-out visitor
  // has no badge to keep up to date — publicNavItems has no Feed tab — so a
  // socket for them would be a socket for nothing.
  // RE-COUNT WHEN THE CHANNEL COMES BACK, and note this one does NOT refresh
  // the route — it re-runs the same count query the two listeners below run,
  // which is the right recovery here for the same reason it is the right
  // callback there: the badge is client state in a layout component that never
  // unmounts, so a router.refresh() would not recompute it.
  //
  // THIS IS THE SURFACE THE DEFECT HURTS LONGEST. The nav is mounted in the
  // layout and survives every navigation in the app, so its channel is the one
  // that has been open across the deploy window, and nothing else ever
  // re-mounts it. The navigation-based re-read above covers leaving
  // /announcements and nothing else. See use-live-channel.ts.
  const subscribe = useLiveChannel(() => {
    void checkUnread();
  });

  useEffect(() => {
    if (!playerId) return;

    const channel = supabase
      .channel('announcements-nav')
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'announcements' }, () => {
        void checkUnread();
      })
      // READS, TOO — the other direction the count can move, and the one the
      // member causes themselves. Filtered to their own rows: every member's
      // reads land in the same table, and an unfiltered subscription would
      // re-run this whole query for the entire club every time anybody opened
      // the announcements screen. RLS already withholds other people's rows
      // (ann_reads_select scopes SELECT to the viewer's own player_id, and
      // Realtime applies the same policy per subscriber), so the filter is
      // about noise rather than about exposure.
      //
      // *** INERT UNTIL THE PUBLICATION SAYS SO. *** announcement_reads is not
      // a member of `supabase_realtime` — 00036 published `ratings` and
      // `announcements` and deliberately nothing else — and a subscription to
      // an unpublished table SUCCEEDS and then never fires, which is the exact
      // silent failure 00036 was written to fix. 00096 adds it; until the owner
      // applies that migration this listener does nothing whatsoever, and the
      // navigation effect above is the entire fix.
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'announcement_reads',
          filter: `player_id=eq.${playerId}`,
        },
        () => {
          void checkUnread();
        },
      );

    const stopWatching = subscribe(channel);

    return () => {
      // BEFORE removeChannel: removing a channel unsubscribes it, which
      // delivers CLOSED to the status callback, and a watcher still listening
      // would read this teardown as an outage and queue a rebuild.
      stopWatching();
      supabase.removeChannel(channel);
    };
  }, [checkUnread, supabase, playerId, subscribe]);

  // Auth, onboarding and the Discord consent screen render their own
  // full-screen layout — no app chrome.
  if (pathname === '/login' || pathname.startsWith('/auth') || pathname === '/onboarding' || pathname.startsWith('/link/')) {
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
