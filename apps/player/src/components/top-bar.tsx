'use client';

import Link from 'next/link';
import { cn } from '@badminton/ui';
import { useNotificationCounts } from '@/components/notification-badges';
import { useProfile } from '@/components/profile-provider';
import { Bell, Settings } from 'lucide-react';

const FALLBACK_CLUB_NAME = 'SFU Badminton';

export function TopBar() {
  const { unreadNotifs: unreadCount } = useNotificationCounts();
  const { profile } = useProfile();
  const playerName = profile?.full_name ?? '';
  const clubName =
    (profile as { club_name?: string | null } | null)?.club_name ?? FALLBACK_CLUB_NAME;

  return (
    <header className="sticky top-0 safe-top bg-[var(--bg-inset)] border-b border-[var(--border)] z-50">
      <div className="max-w-[1100px] mx-auto px-5 h-14 flex items-center justify-between gap-3">
        {/* Brand */}
        <Link href="/feed" className="press flex items-center gap-2 shrink-0">
          <div className="w-7 h-7 rounded-lg gradient-court flex items-center justify-center glow-red">
            <span className="text-xs font-black text-white" style={{ fontFamily: "'Barlow Condensed', sans-serif" }}>SB</span>
          </div>
          <span className="text-[var(--text-primary)] hidden sm:inline" style={{ fontFamily: "'DM Sans', sans-serif", fontSize: '15px', fontWeight: 500 }}>
            {clubName}
          </span>
        </Link>

        {/* Right actions */}
        <div className="flex items-center gap-1 shrink-0">
          <Link
            href="/notifications"
            aria-label="Notifications"
            className="relative p-2.5 min-h-[44px] min-w-[44px] flex items-center justify-center rounded-xl text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-card)] transition-colors duration-150"
          >
            <Bell className={cn(
              'w-5 h-5 transition-transform duration-200',
              unreadCount > 0 ? 'icon-bell-wiggle text-[var(--accent)]' : ''
            )} />
            {unreadCount > 0 && (
              <span className="absolute top-1.5 right-1.5 w-4 h-4 bg-[var(--accent)] rounded-full text-[9px] flex items-center justify-center text-white font-bold">
                {unreadCount > 9 ? '9+' : unreadCount}
              </span>
            )}
          </Link>
          <Link
            href="/settings"
            aria-label="Settings"
            className="press flex items-center gap-2 px-2.5 py-1.5 min-h-[44px] rounded-xl text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-card)] transition-colors duration-150 group"
          >
            <Settings className="w-4 h-4 icon-gear group-hover:text-[var(--text-primary)] transition-colors" />
            <span className="text-sm font-medium hidden sm:inline truncate max-w-[120px]">{playerName}</span>
          </Link>
        </div>
      </div>
    </header>
  );
}
