'use client';

import Link from 'next/link';
import { usePathname, useSearchParams } from 'next/navigation';
import { cn, NavMenu, isRouteActive, isGroupActive } from '@badminton/ui';
import { desktopEntries } from '@/lib/nav-entries';
import { ALL_FEATURES_ENABLED, type FeatureFlags, type FeatureId } from '@badminton/shared/src/utils/features';
import { ShuttleMark } from './shuttle-mark';
import { DiscordMark } from './discord-mark';
import { DISCORD_INVITE_URL } from '@badminton/shared';
import {
  Bell,
  Settings,
  LogIn,
  Shield,
} from 'lucide-react';

export function TopBar({
  playerName,
  avatarUrl,
  unreadCount,
  isAuthenticated,
  isExecOrAdmin,
  activeSeasonName,
  activeSeasonId,
  isApproved = true,
  features = ALL_FEATURES_ENABLED,
  featureAccess = [],
  showDiscord = true,
}: {
  playerName: string;
  avatarUrl?: string | null;
  unreadCount: number;
  isAuthenticated: boolean;
  isExecOrAdmin: boolean;
  activeSeasonName?: string;
  /** The id of the season `activeSeasonName` names, to compare against `?season=`. */
  activeSeasonId?: string;
  /** False while the account is pending approval or suspended. */
  isApproved?: boolean;
  /** The club feature switches, read by the layout. */
  features?: FeatureFlags;
  /** Switched-off features whose `page.access.<id>` key the viewer holds. */
  featureAccess?: readonly FeatureId[];
  /**
   * Whether to link the club Discord: the socials switch and club_socials'
   * show_discord, decided once by the layout.
   */
  showDiscord?: boolean;
}) {
  const pathname = usePathname();
  // This chrome renders above every page, and a LAYOUT never receives
  // searchParams — only a page does. So the label had no way to learn that the
  // screen under it is a finished term, and went on asserting the active season
  // over a past one. `?season=<id>` is the contract season-pick.tsx already
  // writes and my-stats/page.tsx already dispatches on.
  //
  // useSearchParams and NOT the window.location read login/page.tsx uses: the
  // picker changes only the query string, so pathname never changes and an
  // effect keyed on it would never re-run, leaving the label stale after every
  // switch. The hook's production-build <Suspense> requirement applies to
  // STATICALLY PRERENDERED routes; app/layout.tsx is force-dynamic at the root,
  // so nothing in this app prerenders, and season-pick.tsx already calls this
  // same hook under this same layout and ships.
  const viewedSeasonId = useSearchParams()?.get('season') ?? '';
  // Suppression, not substitution: this component has no id-to-name map, and
  // every past-season screen already names its own term (past-season.tsx:267).
  // The only job here is to stop claiming a season the viewer is not looking at.
  const viewingPastSeason = viewedSeasonId !== '' && viewedSeasonId !== activeSeasonId;
  // Gated destinations are filtered on isApproved inside, and a group left
  // empty (Events, for a pending member) is dropped with them.
  // A switched-off feature is dropped the same way, except for a holder of its
  // key, who can still open its pages.
  const navEntries = isAuthenticated ? desktopEntries(isApproved, features, featureAccess) : [];
  // Auth, onboarding and the Discord consent screen render their own
  // full-screen layout — no app chrome.
  if (pathname === '/login' || pathname === '/signup' || pathname.startsWith('/auth') || pathname === '/onboarding' || pathname.startsWith('/link/')) {
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
            {/* Explicit ternaries rather than a chain of && : the bare-truthy
                shape is what put a literal 0 in the profile header (758d0790). */}
            {viewingPastSeason ? (
              <div className="brand-sub">PAST SEASON</div>
            ) : activeSeasonName ? (
              <div className="brand-sub">{activeSeasonName}</div>
            ) : null}
          </div>
        </Link>

        <nav className="nav" aria-label="Main navigation" data-tour="top-nav">
          {isAuthenticated ? (
            navEntries.map((entry) => {
              if (entry.kind === 'link') {
                const { item } = entry;
                const active = isRouteActive(pathname, item.href);
                return (
                  <Link
                    key={item.href}
                    href={item.href}
                    className={cn('nav-item', active && 'active')}
                    aria-current={active ? 'page' : undefined}
                    data-tour={item.href === '/membership' ? 'membership-link' : undefined}
                  >
                    {item.label}
                  </Link>
                );
              }
              const { group } = entry;
              const active = isGroupActive(pathname, group);
              return (
                <NavMenu
                  key={group.id}
                  id={group.id}
                  label={group.label}
                  active={active}
                  pathname={pathname}
                  items={group.items.map((item) => ({
                    href: item.href,
                    label: item.label,
                    icon: item.icon,
                    current: isRouteActive(pathname, item.href),
                  }))}
                  renderLink={(item, props) => <Link href={item.href} {...props} />}
                  triggerClassName={cn('nav-item nav-group', active && 'active')}
                  panelClassName="nav-menu"
                />
              );
            })
          ) : (
            <>
              {features.leaderboard && (
                <Link
                  href="/leaderboard"
                  className={cn('nav-item', pathname.startsWith('/leaderboard') && 'active')}
                  aria-current={pathname.startsWith('/leaderboard') ? 'page' : undefined}
                >
                  Leaderboard
                </Link>
              )}
              {/* /exec IS ready and has been for a while: it lists ten officers
                  from get_executives(), which is granted to anon, and the landing
                  page, the fees page and the settings page all link straight to
                  it. This was an inert aria-disabled span reading "Coming soon",
                  so the only exec-page control in the app chrome silently did
                  nothing when a visitor clicked it — on every page, forever.
                  TODO: add a Contact Us page alongside this later. */}
              <Link
                href="/exec"
                className={cn('nav-item', pathname.startsWith('/exec') && 'active')}
                aria-current={pathname.startsWith('/exec') ? 'page' : undefined}
              >
                Execs
              </Link>
              {features.membership && (
                <Link
                  href="/membership"
                  className={cn('nav-item', pathname.startsWith('/membership') && 'active')}
                  aria-current={pathname.startsWith('/membership') ? 'page' : undefined}
                >
                  Membership
                </Link>
              )}
              {showDiscord && (
                <a href={DISCORD_INVITE_URL} className="nav-item" target="_blank" rel="noopener noreferrer">
                  Discord
                </a>
              )}
            </>
          )}
        </nav>

        <div className="top-right">
          {isAuthenticated ? (
            <>
              {/* Same-origin, and deliberately a plain anchor rather than a
                  next/link: /admin is a different Next app behind the proxy, so
                  client-side routing has nothing to route to. No target="_blank"
                  either — the player app is an installed PWA, and opening the
                  console in a new tab is exactly the ejection that moving it
                  onto this origin was meant to stop. */}
              {isExecOrAdmin && (
                <a
                  href="/admin"
                  className="icon-btn"
                  aria-label="Exec panel"
                  title="Exec panel"
                  style={{ width: 'auto', padding: '0 12px', gap: 6, display: 'inline-flex', alignItems: 'center' }}
                >
                  <Shield className="w-4 h-4" />
                  <span className="hidden md:inline" style={{ fontSize: 13, fontWeight: 600 }}>Exec Panel</span>
                </a>
              )}
              {/* A new tab on purpose, unlike the console link above: Discord is
                  another site (or the Discord app), and the member should land
                  back here when they close it. */}
              {showDiscord && (
                <a
                  href={DISCORD_INVITE_URL}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="icon-btn"
                  aria-label="Join the club Discord"
                  title="Club Discord"
                >
                  <DiscordMark size={16} />
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
              <Link href="/settings" className="me-chip" aria-label="Profile and settings" data-tour="settings-chip">
                <span className="avatar" data-size="sm" data-tone="4" style={{ overflow: 'hidden' }}>
                  {avatarUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={avatarUrl} alt={playerName || 'You'} className="w-full h-full object-cover" style={{ display: 'block' }} />
                  ) : (
                    initials
                  )}
                </span>
                <div>
                  <div className="name">{playerName || 'You'}</div>
                  <div className="sub">Settings</div>
                </div>
                <Settings className="icon-gear w-4 h-4 text-[var(--mute)] hidden md:inline" aria-hidden />
              </Link>
            </>
          ) : (
            // Both doors, as text: a newcomer must not have to find sign-up
            // behind the sign-in page, and the old icon chip lost its words on
            // a phone.
            <div className="row" style={{ gap: 8 }}>
              <Link href="/login" className="btn btn-ghost btn-sm">
                <LogIn className="w-4 h-4" aria-hidden /> Sign in
              </Link>
              <Link href="/signup" className="btn btn-primary btn-sm">
                Join the club
              </Link>
            </div>
          )}
        </div>
      </div>
    </header>
  );
}
