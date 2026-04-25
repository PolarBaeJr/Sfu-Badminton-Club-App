'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { cn } from '@badminton/ui';
import {
  Home,
  Trophy,
  Crosshair,
  Calendar,
  Award,
  Sparkles,
  Bell,
  Search,
  Settings,
} from 'lucide-react';

const desktopNavItems = [
  { href: '/feed',          label: 'Feed',         icon: Home      },
  { href: '/leaderboard',   label: 'Leaderboard',  icon: Trophy    },
  { href: '/challenges',    label: 'Challenges',   icon: Crosshair },
  { href: '/sessions',      label: 'Sessions',     icon: Calendar  },
  { href: '/tournaments',   label: 'Tournaments',  icon: Award     },
  { href: '/my-stats',      label: 'My Stats',     icon: Sparkles  },
];

export function TopBar({ playerName, unreadCount }: { playerName: string; unreadCount: number }) {
  const pathname = usePathname();
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
          <div className="brand-mark">SB</div>
          <div className="brand-wrap">
            <div>SFU Badminton</div>
            <div className="brand-sub">Club · Season 26</div>
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
          <button className="icon-btn" aria-label="Search" type="button">
            <Search className="w-4 h-4" />
          </button>
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
            <span
              className="avatar"
              data-size="sm"
              data-tone="4"
              style={{
                width: 28,
                height: 28,
                borderRadius: 999,
                background: 'var(--surface-2)',
                color: 'var(--ink)',
                display: 'inline-grid',
                placeItems: 'center',
                fontFamily: 'var(--display)',
                fontWeight: 600,
                fontSize: 11,
                border: '1px solid var(--line)',
                flexShrink: 0,
              }}
            >
              {initials}
            </span>
            <div>
              <div className="name">{playerName || 'You'}</div>
              <div className="sub">Settings</div>
            </div>
            <Settings className="icon-gear w-4 h-4 text-[var(--mute)] hidden md:inline" aria-hidden />
          </Link>
        </div>
      </div>
    </header>
  );
}
