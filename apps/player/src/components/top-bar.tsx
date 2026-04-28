'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { cn } from '@badminton/ui';
import { useNotificationCounts } from '@/components/notification-badges';
import { useProfile } from '@/components/profile-provider';
import {
  Home,
  Trophy,
  Swords,
  Calendar,
  Award,
  BarChart3,
  Bell,
  Settings,
} from 'lucide-react';

const desktopNavItems = [
  { href: '/feed',        label: 'Feed',         icon: Home    },
  { href: '/leaderboard', label: 'Leaderboard',  icon: Trophy  },
  { href: '/challenges',  label: 'Challenges',   icon: Swords  },
  { href: '/sessions',    label: 'Sessions',     icon: Calendar},
  { href: '/tournaments', label: 'Tournaments',  icon: Award   },
  { href: '/my-stats',    label: 'My Stats',     icon: BarChart3},
];

export function TopBar() {
  const pathname = usePathname();
  const { unreadNotifs: unreadCount } = useNotificationCounts();
  const { profile } = useProfile();
  const playerName = profile?.full_name ?? '';

  return (
    <header className="sticky top-0 safe-top bg-[var(--bg-primary)]/90 backdrop-blur-xl border-b border-[var(--border)] z-50">
      <div className="max-w-7xl mx-auto px-4 h-14 flex items-center justify-between gap-3">
        {/* Brand */}
        <Link href="/feed" className="press flex items-center gap-2 shrink-0">
          <div className="w-7 h-7 rounded-lg gradient-court flex items-center justify-center glow-red">
            <span className="text-xs font-black text-white" style={{ fontFamily: "'Barlow Condensed', sans-serif" }}>SB</span>
          </div>
          <span className="display-md text-[var(--text-primary)] hidden sm:inline" style={{ fontSize: '1rem' }}>
            SFU Badminton
          </span>
        </Link>

        {/* Desktop nav */}
        <nav className="hidden md:flex items-center gap-0.5 flex-1 justify-center" aria-label="Main navigation">
          {desktopNavItems.map((item) => {
            const active = pathname.startsWith(item.href);
            return (
              <Link
                key={item.href}
                href={item.href}
                className={cn(
                  'flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-lg transition-all duration-200 min-h-[36px]',
                  active
                    ? 'bg-[var(--ds-accent)]/10 text-[var(--ds-accent)] font-semibold'
                    : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-white/[0.04]'
                )}
              >
                <item.icon className="w-3.5 h-3.5 shrink-0" />
                {item.label}
              </Link>
            );
          })}
        </nav>

        {/* Right actions */}
        <div className="flex items-center gap-1 shrink-0">
          <Link
            href="/notifications"
            aria-label="Notifications"
            className="relative p-2.5 min-h-[44px] min-w-[44px] flex items-center justify-center rounded-xl text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-white/[0.05] transition-colors duration-150"
          >
            <Bell className={cn(
              'w-5 h-5 transition-transform duration-200',
              unreadCount > 0 ? 'icon-bell-wiggle text-[var(--ds-accent)]' : ''
            )} />
            {unreadCount > 0 && (
              <span className="absolute top-1.5 right-1.5 w-4 h-4 bg-[var(--ds-accent)] rounded-full text-[9px] flex items-center justify-center text-white font-bold shadow-lg shadow-[var(--color-accent-glow)]">
                {unreadCount > 9 ? '9+' : unreadCount}
              </span>
            )}
          </Link>
          <Link
            href="/settings"
            aria-label="Settings"
            className="press flex items-center gap-2 px-2.5 py-1.5 min-h-[44px] rounded-xl text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-white/[0.05] transition-colors duration-150 group"
          >
            <Settings className="w-4 h-4 icon-gear group-hover:text-[var(--text-primary)] transition-colors" />
            <span className="text-sm font-medium hidden sm:inline truncate max-w-[120px]">{playerName}</span>
          </Link>
        </div>
      </div>
    </header>
  );
}
