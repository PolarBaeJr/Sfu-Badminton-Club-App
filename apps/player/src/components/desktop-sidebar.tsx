'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useProfile } from '@/components/profile-provider';

const NAV = [
  { href: '/feed', label: 'Dashboard' },
  { href: '/leaderboard', label: 'Leaderboard' },
  { href: '/challenges', label: 'Challenge' },
  { href: '/my-matches', label: 'My Matches' },
  { href: '/sessions', label: 'Sessions' },
  { href: '/my-stats', label: 'My Profile' },
  { href: '/settings', label: 'Settings' },
];

export function DesktopSidebar() {
  const pathname = usePathname();
  const { profile } = useProfile();
  const fullName = profile?.full_name ?? 'Player';
  const initials = fullName
    .split(' ')
    .map((p: string) => p[0])
    .filter(Boolean)
    .slice(0, 2)
    .join('')
    .toUpperCase();
  const elo = profile?.singles_elo ?? null;

  return (
    <aside className="d-sidebar d-only">
      <div className="d-sidebar-brand">
        <div className="d-brand-row">
          <div className="d-brand-mark">S</div>
          <div className="d-brand-text">SFU Badminton</div>
        </div>
        <span className="d-brand-portal">Player Portal</span>
      </div>
      <nav className="d-sidebar-nav">
        {NAV.map((item) => {
          const active =
            item.href === '/feed'
              ? pathname === '/feed' || pathname === '/'
              : pathname === item.href || pathname?.startsWith(item.href + '/');
          return (
            <Link
              key={item.href}
              href={item.href}
              className={`d-side-link${active ? ' active' : ''}`}
            >
              {item.label}
            </Link>
          );
        })}
      </nav>
      <Link href="/settings?view=signout" className="d-sidebar-foot">
        <div className="d-player-avatar">{initials}</div>
        <div className="d-player-foot-text">
          <span className="d-player-foot-name">{fullName}</span>
          <span className="d-player-foot-elo">
            {elo != null ? `ELO ${elo}` : 'No rating yet'}
          </span>
        </div>
      </Link>
    </aside>
  );
}
