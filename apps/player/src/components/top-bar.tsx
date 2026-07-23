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
  Shield,
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
  isExecOrAdmin,
  adminUrl,
  activeSeasonName,
}: {
  playerName: string;
  unreadCount: number;
  isAuthenticated: boolean;
  isExecOrAdmin: boolean;
  adminUrl?: string;
  activeSeasonName?: string;
}) {
  const pathname = usePathname();
  const navItems = isAuthenticated ? desktopNavItems : [];
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
        <Link href={isAuthenticated ? '/feed' : '/'} className="brand" aria-label="SFU Badminton home">
          <div className="brand-mark"><ShuttleMark /></div>
          <div className="brand-wrap">
            <div>SFU Badminton</div>
            {activeSeasonName && <div className="brand-sub">{activeSeasonName}</div>}
          </div>
        </Link>

        <nav className="nav" aria-label="Main navigation">
          {isAuthenticated ? (
            navItems.map((item) => {
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
            })
          ) : (
            <>
              <Link
                href="/leaderboard"
                className={cn('nav-item', pathname.startsWith('/leaderboard') && 'active')}
                aria-current={pathname.startsWith('/leaderboard') ? 'page' : undefined}
              >
                Leaderboard
              </Link>
              {/* TODO: activate → link to /exec (exec photo page) when ready; add a Contact Us page here later. */}
              <span className="nav-item" aria-disabled="true" style={{ opacity: 0.4, cursor: 'default' }} title="Coming soon">Execs</span>
            </>
          )}
        </nav>

        <div className="top-right">
          {isAuthenticated ? (
            <>
              {isExecOrAdmin && (
                <a
                  href={adminUrl || '/admin'}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="icon-btn"
                  aria-label="Exec panel"
                  title="Exec panel"
                  style={{ width: 'auto', padding: '0 12px', gap: 6, display: 'inline-flex', alignItems: 'center' }}
                >
                  <Shield className="w-4 h-4" />
                  <span className="hidden md:inline" style={{ fontSize: 13, fontWeight: 600 }}>Exec Panel</span>
                </a>
              )}
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
