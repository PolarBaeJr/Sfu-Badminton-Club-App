'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { cn } from '@badminton/ui';
import { useProfile } from '@/components/profile-provider';

const NAV = [
  { href: '/feed',        label: 'Dashboard'   },
  { href: '/leaderboard', label: 'Leaderboard' },
  { href: '/challenges',  label: 'Challenge'   },
  { href: '/sessions',    label: 'Sessions'    },
  { href: '/my-stats',    label: 'My Stats'    },
  { href: '/tournaments', label: 'Tournaments' },
  { href: '/settings',    label: 'Settings'    },
] as const;

export function SidebarNav() {
  const pathname = usePathname();
  const { profile } = useProfile();
  const playerName = profile?.full_name ?? '';
  const initials = (playerName || 'P').split(' ').map((s) => s[0]).slice(0, 2).join('').toUpperCase() || 'P';
  const elo = (profile as { singles_elo?: number | null } | null)?.singles_elo ?? null;

  return (
    <aside
      className="hidden md:flex flex-col fixed left-0 top-0 bottom-0 z-40"
      style={{
        width: 200,
        background: 'var(--surface1)',
        borderRight: '1px solid var(--hairline)',
      }}
      aria-label="Primary navigation"
    >
      {/* Brand */}
      <Link
        href="/feed"
        className="flex items-center gap-3 px-5"
        style={{ height: 64, borderBottom: '1px solid var(--hairline)' }}
      >
        <span
          className="flex items-center justify-center"
          style={{
            width: 28, height: 28,
            background: 'var(--red)', color: '#fff',
            fontFamily: 'var(--font-display)', fontWeight: 800, fontSize: 16,
          }}
        >S</span>
        <span className="flex flex-col leading-tight">
          <span
            className="uppercase font-bold"
            style={{
              fontFamily: 'var(--font-display)',
              fontSize: 11,
              letterSpacing: '0.18em',
              color: 'var(--red)',
            }}
          >
            SFU Badminton
          </span>
          <span
            className="uppercase"
            style={{
              fontSize: 9,
              letterSpacing: '0.18em',
              color: 'var(--faint)',
              marginTop: 2,
            }}
          >
            Player Portal
          </span>
        </span>
      </Link>

      {/* Nav items */}
      <nav className="flex flex-col py-2 flex-1 overflow-y-auto">
        {NAV.map((item) => {
          const active = pathname === item.href || pathname.startsWith(item.href + '/');
          return (
            <Link
              key={item.href}
              href={item.href}
              aria-current={active ? 'page' : undefined}
              className={cn('flex items-center px-5 uppercase font-semibold transition-colors duration-150 ease-out')}
              style={{
                minHeight: 44,
                fontSize: 11,
                letterSpacing: '0.14em',
                color: active ? 'var(--ink)' : 'var(--faint)',
                borderLeft: active ? '2px solid var(--red)' : '2px solid transparent',
                paddingLeft: active ? 18 : 20,
              }}
              onMouseEnter={(e) => {
                if (!active) e.currentTarget.style.color = 'var(--muted)';
              }}
              onMouseLeave={(e) => {
                if (!active) e.currentTarget.style.color = 'var(--faint)';
              }}
            >
              {item.label}
            </Link>
          );
        })}
      </nav>

      {/* Pinned profile */}
      {playerName && (
        <Link
          href="/settings"
          className="flex items-center gap-3 px-5 py-4"
          style={{ borderTop: '1px solid var(--hairline)' }}
        >
          <span
            className="flex items-center justify-center flex-shrink-0"
            style={{
              width: 32, height: 32,
              background: 'var(--surface3)',
              color: 'var(--ink)',
              fontFamily: 'var(--font-display)',
              fontWeight: 700,
              fontSize: 12,
              letterSpacing: '0.05em',
            }}
          >{initials}</span>
          <span className="flex flex-col min-w-0 leading-tight">
            <span
              className="truncate"
              style={{ fontSize: 12, fontWeight: 500, color: 'var(--ink)' }}
            >{playerName}</span>
            {elo != null && (
              <span
                className="uppercase"
                style={{
                  fontSize: 9,
                  letterSpacing: '0.18em',
                  color: 'var(--muted)',
                  marginTop: 2,
                  fontFamily: 'var(--font-display)',
                }}
              >ELO {elo}</span>
            )}
          </span>
        </Link>
      )}
    </aside>
  );
}
