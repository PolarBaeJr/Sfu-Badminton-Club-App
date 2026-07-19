'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { cn } from '@badminton/ui';
import {
  LayoutDashboard,
  Users,
  Trophy,
  Medal,
  ScrollText,
  Settings,
  Target,
  Calendar,
  DollarSign,
  Megaphone,
  LogOut,
} from 'lucide-react';
import { useState, useEffect } from 'react';
import { createClient } from '@/lib/supabase-browser';
import { canAccess, type AccessLevel } from '@/lib/permissions';

// Grouped by access level (see permissions.ts SECTION_ACCESS): the top section
// is everything execs can reach; the bottom section is admin-only and filters
// away entirely for execs.
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
    ],
  },
  {
    title: 'Admin only',
    items: [
      { href: '/players', label: 'Players', icon: Users },
      { href: '/fees', label: 'Fees', icon: DollarSign },
      { href: '/audit', label: 'Audit Log', icon: ScrollText },
      { href: '/settings', label: 'Settings', icon: Settings },
    ],
  },
];

export function Sidebar() {
  const pathname = usePathname();
  const [userEmail, setUserEmail] = useState<string | null>(null);
  const [accessLevel, setAccessLevel] = useState<AccessLevel | null>(null);
  const [accessLoaded, setAccessLoaded] = useState(false);

  // Don't render header on public routes
  const isPublicRoute =
    pathname === '/login' ||
    pathname.startsWith('/auth') ||
    pathname === '/unauthorized' ||
    pathname === '/unavailable';

  // Load user email + access level (drives nav filtering for execs)
  useEffect(() => {
    const supabase = createClient();
    supabase.auth.getUser().then(async ({ data: { user } }) => {
      if (user) {
        setUserEmail(user.email ?? null);
        const { data: level } = await supabase.rpc('admin_access_level', { p_user_id: user.id });
        setAccessLevel((level as AccessLevel | null) ?? null);
      }
      setAccessLoaded(true);
    });
  }, []);

  async function handleSignOut() {
    const supabase = createClient();
    await supabase.auth.signOut();
    window.location.href = '/login';
  }

  if (isPublicRoute) return null;

  // Until the access level resolves, show everything (avoids an empty-nav
  // flash for the common admin case); once loaded, hide sections execs
  // can't reach. The server action is the real boundary — this is cosmetic.
  const visibleItems = navSections.map((section) =>
    section.items.filter((item) => !accessLoaded || canAccess(accessLevel, item.href))
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
        <nav className="flex items-center overflow-x-auto">
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
