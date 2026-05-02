'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useNotificationCounts } from '@/components/notification-badges';
import { ShuttleMark } from '@/components/v2/atoms';

type IconName = 'home' | 'trophy' | 'shuttle' | 'calendar' | 'user';

const TABS: { href: string; label: string; icon: IconName; primary?: boolean }[] = [
  { href: '/feed',        label: 'Home',      icon: 'home' },
  { href: '/leaderboard', label: 'Ranks',     icon: 'trophy' },
  { href: '/challenges',  label: 'Challenge', icon: 'shuttle', primary: true },
  { href: '/sessions',    label: 'Sessions',  icon: 'calendar' },
  { href: '/my-stats',    label: 'Profile',   icon: 'user' },
];

function TabIcon({ name, color }: { name: IconName; color: string }) {
  if (name === 'home')
    return (
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2">
        <path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
        <polyline points="9 22 9 12 15 12 15 22" />
      </svg>
    );
  if (name === 'trophy')
    return (
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2">
        <path d="M6 9H4.5a2.5 2.5 0 0 1 0-5H6" />
        <path d="M18 9h1.5a2.5 2.5 0 0 0 0-5H18" />
        <path d="M4 22h16" />
        <path d="M10 14.66V17c0 .55-.47.98-.97 1.21C7.85 18.75 7 20.24 7 22" />
        <path d="M14 14.66V17c0 .55.47.98.97 1.21C16.15 18.75 17 20.24 17 22" />
        <path d="M18 2H6v7a6 6 0 0 0 12 0V2z" />
      </svg>
    );
  if (name === 'calendar')
    return (
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2">
        <rect x="3" y="4" width="18" height="18" rx="2" ry="2" />
        <line x1="16" y1="2" x2="16" y2="6" />
        <line x1="8" y1="2" x2="8" y2="6" />
        <line x1="3" y1="10" x2="21" y2="10" />
      </svg>
    );
  if (name === 'user')
    return (
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2">
        <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
        <circle cx="12" cy="7" r="4" />
      </svg>
    );
  return null;
}

export function BottomNav() {
  const pathname = usePathname();
  const { incomingChallenges } = useNotificationCounts();

  return (
    <nav
      style={{
        flexShrink: 0,
        borderTop: '1px solid #303030',
        background: '#181818',
        padding: '8px 8px calc(8px + env(safe-area-inset-bottom, 14px)) 8px',
        display: 'grid',
        gridTemplateColumns: 'repeat(5, 1fr)',
        position: 'relative',
        zIndex: 50,
      }}
      aria-label="Primary navigation"
    >
      {TABS.map((t) => {
        const active = pathname === t.href || pathname.startsWith(t.href + '/');
        const showBadge = t.href === '/challenges' && incomingChallenges > 0;

        if (t.primary) {
          return (
            <Link
              key={t.href}
              href={t.href}
              aria-current={active ? 'page' : undefined}
              style={{
                background: 'transparent',
                border: 'none',
                cursor: 'pointer',
                padding: '8px 0',
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                gap: 4,
                position: 'relative',
                color: active ? '#da291c' : '#666',
              }}
            >
              <div style={{ position: 'relative', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <ShuttleMark size={20} color={active ? '#da291c' : '#666'} />
                {showBadge && (
                  <span
                    style={{
                      position: 'absolute',
                      top: -6,
                      right: -10,
                      minWidth: 16,
                      height: 16,
                      padding: '0 4px',
                      background: '#da291c',
                      color: '#fff',
                      fontSize: 9,
                      fontWeight: 700,
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      border: '2px solid #181818',
                    }}
                  >
                    {incomingChallenges > 9 ? '9+' : incomingChallenges}
                  </span>
                )}
              </div>
              <span
                style={{
                  fontSize: 9,
                  fontWeight: 700,
                  color: active ? '#da291c' : '#666',
                  letterSpacing: '1.4px',
                  textTransform: 'uppercase',
                }}
              >
                {t.label}
              </span>
            </Link>
          );
        }
        const c = active ? '#fff' : '#666';
        return (
          <Link
            key={t.href}
            href={t.href}
            aria-current={active ? 'page' : undefined}
            style={{
              background: 'transparent',
              border: 'none',
              cursor: 'pointer',
              padding: '8px 0',
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              gap: 4,
            }}
          >
            <TabIcon name={t.icon} color={c} />
            <span
              style={{
                fontSize: 9,
                fontWeight: 700,
                color: c,
                letterSpacing: '1.4px',
                textTransform: 'uppercase',
              }}
            >
              {t.label}
            </span>
          </Link>
        );
      })}
    </nav>
  );
}
