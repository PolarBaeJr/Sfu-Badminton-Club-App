'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useState, useEffect } from 'react';
import { cn } from '@badminton/ui';
import { createClient } from '@/lib/supabase-browser';
import { Home, Trophy, Crosshair, Calendar, Sparkles } from 'lucide-react';

const navItems = [
  { href: '/feed',        label: 'Feed',  icon: Home      },
  { href: '/leaderboard', label: 'Ranks', icon: Trophy    },
  { href: '/challenges',  label: 'Vs.',   icon: Crosshair },
  { href: '/sessions',    label: 'Play',  icon: Calendar  },
  { href: '/my-stats',    label: 'Me',    icon: Sparkles  },
];

export function BottomNav() {
  const pathname = usePathname();
  const [unreadAnnouncements, setUnreadAnnouncements] = useState(0);

  useEffect(() => {
    const supabase = createClient();

    async function checkUnread() {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) return;
      const { data: player } = await supabase.from('players').select('id').eq('user_id', user.id).single();
      if (!player) return;

      const { count: totalAnnouncements } = await supabase
        .from('announcements')
        .select('*', { count: 'exact', head: true })
        .eq('status', 'published');

      const { count: readCount } = await supabase
        .from('announcement_reads')
        .select('*', { count: 'exact', head: true })
        .eq('player_id', player.id);

      setUnreadAnnouncements(Math.max(0, (totalAnnouncements ?? 0) - (readCount ?? 0)));
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

  return (
    <nav className="mobile-tabbar" aria-label="Mobile navigation">
      {navItems.map((item) => {
        const active = pathname.startsWith(item.href);
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
