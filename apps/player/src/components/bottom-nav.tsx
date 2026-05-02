'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { cn } from '@badminton/ui';
import { useNotificationCounts } from '@/components/notification-badges';
import { Home, Trophy, Swords, Calendar, Megaphone } from 'lucide-react';

const navItems = [
  { href: '/feed',          label: 'Home',      icon: Home     },
  { href: '/leaderboard',   label: 'Ranks',     icon: Trophy   },
  { href: '/challenges',    label: 'Challenge', icon: Swords   },
  { href: '/sessions',      label: 'Sessions',  icon: Calendar },
  { href: '/announcements', label: 'News',      icon: Megaphone},
];

export function BottomNav() {
  const pathname = usePathname();
  const { unreadAnnouncements } = useNotificationCounts();

  return (
    <nav
      className="fixed bottom-0 left-0 right-0 bg-[var(--bg-inset)] border-t border-[var(--border)] z-50 md:hidden safe-bottom"
      aria-label="Mobile navigation"
    >
      <div className="flex justify-around max-w-md mx-auto">
        {navItems.map((item) => {
          const active = pathname.startsWith(item.href);
          const isLeaderboard    = item.href === '/leaderboard';
          const isAnnouncements  = item.href === '/announcements';
          const hasUnread        = isAnnouncements && unreadAnnouncements > 0;

          return (
            <Link
              key={item.href}
              href={item.href}
              className={cn(
                'press flex flex-col items-center py-1.5 px-3 text-[10px] min-h-[48px] min-w-[56px] justify-center relative transition-colors duration-150',
                active ? 'text-[var(--accent)]' : 'text-[var(--text-muted)]'
              )}
              aria-current={active ? 'page' : undefined}
            >
              <div className={cn(
                'p-1.5 rounded-xl transition-all duration-200 mb-0.5',
                active ? 'bg-[var(--bg-accent)]' : 'hover:bg-[var(--bg-card)]'
              )}>
                <item.icon
                  className={cn(
                    'w-5 h-5 transition-all duration-200',
                    active && 'stroke-[2.5]',
                    active && isLeaderboard && 'icon-trophy-shimmer',
                    hasUnread && !active && 'text-[var(--accent)]'
                  )}
                />
              </div>
              <span className={cn(
                'font-medium transition-colors duration-150',
                active ? 'text-[var(--accent)]' : 'text-[var(--text-muted)]'
              )}>
                {item.label}
              </span>
              {hasUnread && (
                <span
                  className="absolute top-1.5 right-1.5 w-4 h-4 bg-[var(--accent)] text-white text-[9px] rounded-full flex items-center justify-center font-bold"
                  aria-label={`${unreadAnnouncements} unread announcements`}
                >
                  {unreadAnnouncements > 9 ? '9+' : unreadAnnouncements}
                </span>
              )}
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
