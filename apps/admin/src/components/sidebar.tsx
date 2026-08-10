'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { cn } from '@badminton/ui';
// Deep import, not the '@badminton/shared' barrel — see the player middleware.
import { clearHostOnlyAuthCookies } from '@badminton/shared/src/utils/constants';
import { withBase } from '@/lib/base-path';
import {
  LayoutDashboard,
  Users,
  Trophy,
  Medal,
  Scale,
  ScrollText,
  Settings,
  Gauge,
  UserCog,
  Target,
  Calendar,
  DollarSign,
  Megaphone,
  ShieldCheck,
  LogOut,
} from 'lucide-react';
import { useState, useEffect } from 'react';
import { createClient } from '@/lib/supabase-browser';
import { canAccess, type AccessLevel, type Portfolio } from '@/lib/permissions';

// Two nav ROWS, not two access levels. Every item in both is filtered through
// canAccess() against the same SECTION_ACCESS map the middleware uses, so this
// list can never offer a door that will not open — grouping is layout only.
//
// The first row is the day-to-day club work an exec does; the second is the
// back-office row, which happens to be mostly admin-only but is not uniformly
// so (/players and /settings reach down to trainers, /legal to execs). Put a
// section wherever it belongs on screen and let canAccess() do the deciding:
// hand-keeping a second idea of who may see what is exactly how execs came to
// be shown four links that bounced them to /unauthorized.
// How quickly a promotion or demotion reaches an already-open console tab.
const POLL_MS = 5000;

const navSections = [
  {
    title: 'Manage',
    items: [
      { href: '/dashboard', label: 'Dashboard', icon: LayoutDashboard },
      { href: '/matches', label: 'Matches', icon: Target },
      { href: '/tournaments', label: 'Tournaments', icon: Trophy },
      { href: '/sessions', label: 'Sessions', icon: Calendar },
      { href: '/announcements', label: 'Announcements', icon: Megaphone },
      { href: '/seasons', label: 'Seasons', icon: Medal },
      // Route stays /fees — it is the section's access key in permissions.ts
      // and every existing link and revalidatePath points at it. The label is
      // "Finances" because the section is no longer only fees: other income and
      // expenses are tabs on the same page.
      //
      // Sits in the first row now that /fees is exec-level: for an exec it is
      // the only back-office link they have, and left in the second row it
      // would have rendered as a one-item strip under a divider. An exec who
      // follows it lands on the Expenses tab and sees nothing else — the page
      // decides that, not this list.
      { href: '/fees', label: 'Finances', icon: DollarSign },
    ],
  },
  {
    title: 'Admin only',
    items: [
      { href: '/players', label: 'Players', icon: Users },
      { href: '/permissions', label: 'Permissions', icon: ShieldCheck },
      // Platform configuration, split out of /settings — which stays trainer-level
      // for passkey enrolment and no longer carries any of it.
      { href: '/ratings', label: 'Ratings', icon: Gauge },
      { href: '/accounts', label: 'Accounts', icon: UserCog },
      { href: '/legal', label: 'Legal', icon: Scale },
      { href: '/audit', label: 'Audit Log', icon: ScrollText },
      { href: '/settings', label: 'Settings', icon: Settings },
    ],
  },
];

export function Sidebar({
  initialAccessLevel = null,
  initialPortfolio = null,
}: {
  initialAccessLevel?: AccessLevel | null;
  initialPortfolio?: Portfolio | null;
}) {
  const pathname = usePathname();
  const router = useRouter();
  const [userEmail, setUserEmail] = useState<string | null>(null);
  // Seeded from the server so the FIRST paint is already filtered. The effect
  // below still runs (it also fetches the email, and refreshes the level on a
  // client-side navigation), but it no longer decides what the user sees first.
  const [accessLevel, setAccessLevel] = useState<AccessLevel | null>(initialAccessLevel);
  // The exec portfolio, polled alongside the level so a re-assignment reaches an
  // open tab the same way a promotion does.
  const [portfolio, setPortfolio] = useState<Portfolio | null>(initialPortfolio);
  const [accessLoaded, setAccessLoaded] = useState(initialAccessLevel !== null);

  // Don't render header on public routes
  const isPublicRoute =
    pathname === '/login' ||
    pathname.startsWith('/auth') ||
    pathname === '/unauthorized' ||
    pathname === '/unavailable';

  // Load the email once, then keep the access level fresh.
  //
  // POLLED, not one-shot: a promotion or demotion has to reach an open tab
  // without waiting for the person to navigate. Server components already read
  // the level per request, and the middleware re-checks it on every request, so
  // the only stale surface is a tab someone is sitting on — this closes it
  // within POLL_MS.
  //
  // Paused while the tab is hidden. A console left open in a background tab
  // overnight should not be doing anything.
  useEffect(() => {
    const supabase = createClient();
    let cancelled = false;
    let timer: ReturnType<typeof setInterval> | null = null;

    async function readLevel(): Promise<void> {
      const { data: { user } } = await supabase.auth.getUser();
      if (cancelled) return;
      if (!user) { setAccessLoaded(true); return; }
      setUserEmail(user.email ?? null);

      const { data: level, error } = await supabase.rpc('admin_access_level', { p_user_id: user.id });
      if (cancelled) return;
      // Only trust a SUCCESSFUL read. supabase-js returns data: null on error,
      // so writing it unconditionally would turn a transient RPC failure into
      // "you have no access" — and since the nav now fails closed, that emptied
      // the whole sidebar until a reload.
      if (error) { setAccessLoaded(true); return; }

      const next = (level as AccessLevel | null) ?? null;

      // Only an exec can hold a portfolio, so nobody else pays for this call.
      // Failing OPEN (null = no portfolio = today's exec access) on purpose:
      // this code can run against a database where 00086 has not been applied
      // and admin_portfolio() does not exist, and the middleware makes the same
      // choice. The nav is cosmetic; the server actions are the boundary.
      let nextPortfolio: Portfolio | null = null;
      if (next === 'exec') {
        const { data: p, error: portfolioError } = await supabase.rpc('admin_portfolio', { p_user_id: user.id });
        if (cancelled) return;
        if (!portfolioError) nextPortfolio = (p as Portfolio | null) ?? null;
      }
      // Same treatment as the level below: server components were rendered with
      // the old portfolio, so a change has to re-render them too.
      setPortfolio((prev) => {
        if (prev !== nextPortfolio) router.refresh();
        return nextPortfolio;
      });

      setAccessLevel((prev) => {
        // Server components hold the old level too, so re-render them rather
        // than leaving a half-updated page — the nav would say one thing and
        // the page body another.
        if (prev !== next) router.refresh();
        return next;
      });
      setAccessLoaded(true);
    }

    void readLevel();

    function start() {
      if (timer === null) timer = setInterval(() => { void readLevel(); }, POLL_MS);
    }
    function stop() {
      if (timer !== null) { clearInterval(timer); timer = null; }
    }
    function onVisibility() {
      if (document.visibilityState === 'visible') { void readLevel(); start(); } else { stop(); }
    }

    if (document.visibilityState === 'visible') start();
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      cancelled = true;
      stop();
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [router]);

  async function handleSignOut() {
    const supabase = createClient();
    await supabase.auth.signOut();
    // The library's own sign-out only clears the cookie on its configured
    // scope; a leftover host-only copy from before the switch would still be a
    // valid session. No-op once no such copy exists.
    clearHostOnlyAuthCookies();
    window.location.href = withBase('/login');
  }

  if (isPublicRoute) return null;

  // Fails CLOSED: nothing is shown until the access level is known. The layout
  // seeds it from the server, so in practice this resolves before first paint
  // and nothing flashes at all. It only bites on a public route or if the
  // lookup threw — and an empty nav for a moment is the right failure, because
  // the alternative was execs watching admin-only sections appear and vanish on
  // every load.
  //
  // Still cosmetic, not a boundary: the middleware and every server action gate
  // independently. This just stops the UI advertising doors that won't open.
  const visibleItems = navSections.map((section) =>
    section.items.filter((item) => accessLoaded && canAccess(accessLevel, portfolio, item.href))
  );
  const manageItems = visibleItems[0] ?? [];
  const adminItems = visibleItems[1] ?? [];

  const navLink = (item: { href: string; label: string }) => {
    const isActive = pathname.startsWith(item.href);
    return (
      <Link
        key={item.href}
        href={item.href}
        className={cn(
          'relative px-3 py-3.5 text-[11px] font-semibold uppercase tracking-[0.08em] whitespace-nowrap transition-colors',
          isActive
            ? 'text-[var(--text-primary)]'
            : 'text-[var(--text-muted)] hover:text-[var(--text-primary)]'
        )}
      >
        {item.label}
        {isActive && (
          <span className="absolute left-3 right-3 bottom-0 h-[2px] bg-[var(--color-accent)]" />
        )}
      </Link>
    );
  };

  return (
    <header className="sticky top-0 z-40 bg-[var(--bg-primary)] border-b border-[var(--border)]">
      {/* Row 1 — brand + Manage nav + user */}
      <div className="flex items-center gap-4 px-4 lg:px-6">
        <Link href="/dashboard" className="flex items-center gap-2.5 flex-shrink-0 py-2.5">
          <span className="w-8 h-8 grid place-items-center bg-[var(--color-accent)] text-white font-display font-bold text-sm">
            SB
          </span>
          <span className="hidden sm:block text-xs font-bold uppercase tracking-[0.12em] whitespace-nowrap text-[var(--text-primary)]">
            SFU Badminton <span className="text-[var(--text-muted)]">· Admin</span>
          </span>
        </Link>
        <nav className="flex items-center overflow-x-auto min-w-0">
          {manageItems.map(navLink)}
        </nav>
        <div className="ml-auto flex items-center gap-3 flex-shrink-0">
          {userEmail && (
            <span className="hidden lg:block text-xs text-[var(--text-muted)] truncate max-w-[200px]">
              {userEmail}
            </span>
          )}
          <button
            onClick={handleSignOut}
            className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.08em] text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-colors whitespace-nowrap"
          >
            <LogOut className="w-4 h-4" />
            <span className="hidden md:inline">Sign out</span>
          </button>
        </div>
      </div>

      {/* Row 2 — Admin-only sub-nav (hairline top; the header border gives the bottom) */}
      {adminItems.length > 0 && (
        <nav className="flex items-center overflow-x-auto px-4 lg:px-6 border-t border-[var(--border)]">
          {adminItems.map(navLink)}
        </nav>
      )}
    </header>
  );
}
