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
  Megaphone,
  LogOut,
  Menu,
  X,
} from 'lucide-react';
import { useState, useEffect } from 'react';
import { createClient } from '@badminton/shared/supabase-browser';

type SidebarProps = { userEmail?: string | null };

const navSections = [
  {
    title: 'Manage',
    items: [
      { href: '/dashboard', label: 'Dashboard', icon: LayoutDashboard },
      { href: '/players', label: 'Players', icon: Users },
      { href: '/matches', label: 'Matches', icon: Target },
      { href: '/tournaments', label: 'Tournaments', icon: Trophy },
      { href: '/sessions', label: 'Sessions', icon: Calendar },
      { href: '/announcements', label: 'Announcements', icon: Megaphone },
    ],
  },
  {
    title: 'System',
    items: [
      { href: '/seasons', label: 'Seasons', icon: Medal },
      { href: '/audit', label: 'Audit Log', icon: ScrollText },
      { href: '/settings', label: 'Settings', icon: Settings },
    ],
  },
];

export function Sidebar({ userEmail = null }: SidebarProps = {}) {
  const pathname = usePathname();
  const [mobileOpen, setMobileOpen] = useState(false);

  // Don't render sidebar on public routes
  const isPublicRoute =
    pathname === '/login' ||
    pathname.startsWith('/auth') ||
    pathname === '/unauthorized';

  // Close mobile menu on navigation
  useEffect(() => {
    setMobileOpen(false);
  }, [pathname]);

  async function handleSignOut() {
    const supabase = createClient();
    await supabase.auth.signOut();
    window.location.href = '/login';
  }

  const sidebarContent = (
    <>
      {/* Header */}
      <div className="p-4 border-b border-[var(--border)] flex items-center justify-between">
        <div>
          <h1 className="text-lg font-bold text-[var(--ds-accent)] font-display tracking-wider">SFU BADMINTON</h1>
          <p className="text-[10px] text-[var(--text-muted)] uppercase tracking-widest mt-0.5">Admin Panel</p>
        </div>
        <button
          onClick={() => setMobileOpen(false)}
          className="md:hidden p-1.5 rounded-md text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--border-hover)] transition-colors"
        >
          <X className="w-5 h-5" />
        </button>
      </div>

      {/* Navigation */}
      <nav className="flex-1 py-3 overflow-y-auto space-y-4">
        {navSections.map((section) => (
          <div key={section.title}>
            <p className="px-5 mb-1.5 text-[10px] font-semibold text-[var(--text-muted)] uppercase tracking-widest">
              {section.title}
            </p>
            <div className="space-y-0.5 px-2">
              {section.items.map((item) => {
                const isActive = pathname.startsWith(item.href);
                const Icon = item.icon;
                return (
                  <Link
                    key={item.href}
                    href={item.href}
                    aria-current={isActive ? 'page' : undefined}
                    className={cn(
                      'flex items-center gap-3 text-sm transition-colors duration-150 group relative pl-3 pr-3 py-2.5 border-l-2',
                      isActive
                        ? 'bg-[var(--ds-accent-dim)] text-[var(--ds-accent)] border-[var(--ds-accent)]'
                        : 'text-[var(--text-muted)] hover:text-[var(--text-primary)] border-transparent hover:bg-white/[0.03]'
                    )}
                  >
                    <Icon className={cn('w-[18px] h-[18px] flex-shrink-0', isActive && 'text-[var(--ds-accent)]')} />
                    <span className="font-medium">{item.label}</span>
                  </Link>
                );
              })}
            </div>
          </div>
        ))}
      </nav>

      {/* Footer — user info + logout */}
      <div className="p-4 border-t border-[var(--border)] space-y-3">
        {userEmail && (
          <p className="text-xs text-[var(--text-muted)] truncate">{userEmail}</p>
        )}
        <button
          onClick={handleSignOut}
          className="flex items-center gap-2 text-sm text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-colors w-full"
        >
          <LogOut className="w-4 h-4" />
          Sign out
        </button>
      </div>
    </>
  );

  if (isPublicRoute) return null;

  return (
    <>
      {/* Mobile hamburger button */}
      <button
        onClick={() => setMobileOpen(true)}
        className="md:hidden fixed top-4 left-4 z-50 p-2 rounded-lg bg-[var(--bg-elevated)] border border-[var(--border)] text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-colors"
      >
        <Menu className="w-5 h-5" />
      </button>

      {/* Mobile overlay */}
      {mobileOpen && (
        <div
          className="md:hidden fixed inset-0 bg-black/50 z-40"
          onClick={() => setMobileOpen(false)}
        />
      )}

      {/* Sidebar — hidden on mobile unless mobileOpen */}
      <aside
        className={cn(
          'fixed left-0 top-0 bottom-0 bg-[var(--bg-elevated)] border-r border-[var(--border)] flex flex-col z-50 w-[220px] transition-transform duration-300',
          mobileOpen ? 'translate-x-0' : '-translate-x-full md:translate-x-0'
        )}
      >
        {sidebarContent}
      </aside>
    </>
  );
}
