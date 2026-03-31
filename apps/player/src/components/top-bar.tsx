'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { cn } from '@badminton/ui';
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
  { href: '/feed', label: 'Feed', icon: Home },
  { href: '/leaderboard', label: 'Leaderboard', icon: Trophy },
  { href: '/challenges', label: 'Challenges', icon: Swords },
  { href: '/sessions', label: 'Sessions', icon: Calendar },
  { href: '/tournaments', label: 'Tournaments', icon: Award },
  { href: '/my-stats', label: 'My Stats', icon: BarChart3 },
];

export function TopBar({ playerName, unreadCount }: { playerName: string; unreadCount: number }) {
  const pathname = usePathname();

  return (
    <header className="sticky top-0 bg-[#0A0E1A]/90 backdrop-blur-xl border-b border-white/[0.06] z-50">
      <div className="max-w-7xl mx-auto px-4 h-14 flex items-center justify-between">
        <Link href="/feed" className="flex items-center gap-2">
          <div className="w-7 h-7 rounded-lg bg-gradient-to-br from-[#EF4444] to-[#DC2626] flex items-center justify-center">
            <span className="text-xs font-black text-white font-display">SB</span>
          </div>
          <span className="text-lg font-black text-shuttle-white font-display tracking-wider uppercase hidden sm:inline">
            SFU Badminton
          </span>
        </Link>

        {/* Desktop nav */}
        <nav className="hidden md:flex items-center gap-0.5">
          {desktopNavItems.map((item) => {
            const active = pathname.startsWith(item.href);
            return (
              <Link
                key={item.href}
                href={item.href}
                className={cn(
                  'flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-lg transition-all duration-200',
                  active
                    ? 'bg-[#EF4444]/10 text-[#EF4444] font-semibold'
                    : 'text-[#94A3B8] hover:text-shuttle-white hover:bg-white/[0.04]'
                )}
              >
                <item.icon className="w-3.5 h-3.5" />
                {item.label}
              </Link>
            );
          })}
        </nav>

        <div className="flex items-center gap-2">
          <Link
            href="/notifications"
            className="relative p-2 rounded-lg text-[#94A3B8] hover:text-shuttle-white hover:bg-white/[0.04] transition-colors"
          >
            <Bell className="w-5 h-5" />
            {unreadCount > 0 && (
              <span className="absolute top-1 right-1 w-4 h-4 bg-[#EF4444] rounded-full text-[10px] flex items-center justify-center text-white font-bold animate-pulse">
                {unreadCount > 9 ? '9+' : unreadCount}
              </span>
            )}
          </Link>
          <Link
            href="/settings"
            className="flex items-center gap-2 px-2.5 py-1.5 rounded-lg text-[#94A3B8] hover:text-shuttle-white hover:bg-white/[0.04] transition-colors"
          >
            <Settings className="w-4 h-4" />
            <span className="text-sm font-medium hidden sm:inline">{playerName}</span>
          </Link>
        </div>
      </div>
    </header>
  );
}
