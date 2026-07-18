'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { cn } from '@badminton/ui';
import { ShuttleMark } from './shuttle-mark';
import {
  Home,
  Trophy,
  Crosshair,
  Calendar,
  Award,
  Sparkles,
  Bell,
  Settings,
  LogIn,
} from 'lucide-react';

const desktopNavItems = [
  { href: '/feed',          label: 'Feed',         icon: Home      },
  { href: '/leaderboard',   label: 'Leaderboard',  icon: Trophy    },
  { href: '/challenges',    label: 'Challenges',   icon: Crosshair },
  { href: '/sessions',      label: 'Schedule',     icon: Calendar  },
  { href: '/tournaments',   label: 'Tournaments',  icon: Award     },
  { href: '/my-stats',      label: 'My Stats',     icon: Sparkles  },
];

export function TopBar({
  playerName,
  unreadCount,
  isAuthenticated,
  activeSeasonName,
}: {
  playerName: string;
  unreadCount: number;
  isAuthenticated: boolean;
  activeSeasonName?: string;
}) {
  const pathname = usePathname();
  // Auth / onboarding screens render their own full-screen layout — no app chrome.
  if (pathname === '/login' || pathname.startsWith('/auth') || pathname === '/onboarding') {
    return null;
  }
  const initials = (playerName || 'You')
    .split(' ')
    .map((part) => part[0])
    .filter(Boolean)
    .slice(0, 2)
    .join('')
    .toUpperCase();

  return (
    <header className="topbar safe-top">
      <div className="topbar-inner">
        <Link href="/feed" className="brand" aria-label="SFU Badminton home">
          <div className="brand-mark"><ShuttleMark /></div>
          <div className="brand-wrap">
            <div>SFU Badminton</div>
            {activeSeasonName && <div className="brand-sub">{activeSeasonName}</div>}
          </div>
        </Link>

        <nav className="nav" aria-label="Main navigation">
          {desktopNavItems.map((item) => {
            const active = pathname.startsWith(item.href);
            return (
              <Link
                key={item.href}
                href={item.href}
                className={cn('nav-item', active && 'active')}
                aria-current={active ? 'page' : undefined}
              >
                {item.label}
              </Link>
            );
          })}
        </nav>

        <div className="top-right">
          {isAuthenticated ? (
            <>
              <Link
                href="/notifications"
                aria-label={unreadCount > 0 ? `Notifications (${unreadCount} unread)` : 'Notifications'}
                className="icon-btn"
                style={{ position: 'relative' }}
              >
                <Bell className={cn('w-4 h-4', unreadCount > 0 && 'icon-bell-wiggle')} />
                {unreadCount > 0 && (
                  <span
                    style={{
                      position: 'absolute',
                      top: 4,
                      right: 4,
                      width: 8,
                      height: 8,
                      borderRadius: 999,
                      background: 'var(--red)',
                      border: '2px solid var(--surface)',
                    }}
                  />
                )}
              </Link>
              <Link href="/settings" className="me-chip" aria-label="Profile and settings">
                <span className="avatar" data-size="sm" data-tone="4">
                  {initials}
                </span>
                <div>
                  <div className="name">{playerName || 'You'}</div>
                  <div className="sub">Settings</div>
                </div>
                <Settings className="icon-gear w-4 h-4 text-[var(--mute)] hidden md:inline" aria-hidden />
              </Link>
            </>
          ) : (
            <Link href="/login" className="me-chip" aria-label="Sign in">
              <span className="avatar" data-size="sm" data-tone="4" aria-hidden>
                <LogIn className="w-4 h-4" />
              </span>
              <div>
                <div className="name">Sign in</div>
                <div className="sub">to your account</div>
              </div>
            </Link>
          )}
        </div>
      </div>
    </header>
  );
}
