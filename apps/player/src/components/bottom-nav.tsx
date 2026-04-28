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
      className="fixed bottom-0 left-0 right-0 bg-[var(--bg-primary)]/95 backdrop-blur-xl border-t border-[var(--border)] z-50 md:hidden safe-bottom"
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
                'press flex flex-col items-center py-2 px-3 text-[10px] min-h-[56px] min-w-[56px] justify-center relative transition-colors duration-150',
                active ? 'text-[var(--ds-accent)]' : 'text-[var(--text-muted)]'
              )}
              aria-current={active ? 'page' : undefined}
            >
              <div className={cn(
                'p-1.5 rounded-xl transition-all duration-200 mb-0.5',
                active ? 'bg-[var(--ds-accent)]/10 glow-red' : 'hover:bg-white/[0.04]'
              )}>
                <item.icon
                  className={cn(
                    'w-5 h-5 transition-all duration-200',
                    active && 'stroke-[2.5]',
                    active && isLeaderboard && 'icon-trophy-shimmer',
                    hasUnread && !active && 'text-[var(--ds-accent)]'
                  )}
                />
              </div>
              <span className={cn(
                'font-semibold transition-colors duration-150',
                active ? 'text-[var(--ds-accent)]' : 'text-[var(--text-muted)]'
              )}>
                {item.label}
              </span>
              {hasUnread && (
                <span
                  className="absolute top-1.5 right-1.5 w-4 h-4 bg-[var(--ds-accent)] text-white text-[9px] rounded-full flex items-center justify-center font-bold shadow-lg"
                  style={{ boxShadow: '0 2px 8px var(--color-accent-glow)' }}
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
