'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { cn } from '@badminton/ui';
import {
  LayoutDashboard,
  Users,
  Swords,
  Trophy,
  CalendarDays,
  Medal,
  Megaphone,
  GraduationCap,
  ScrollText,
  Settings,
  Target,
  ChevronLeft,
  LogOut,
} from 'lucide-react';
import { useState } from 'react';

const navSections = [
  {
    title: 'Overview',
    items: [
      { href: '/dashboard', label: 'Dashboard', icon: LayoutDashboard },
    ],
  },
  {
    title: 'Management',
    items: [
      { href: '/players', label: 'Players', icon: Users },
      { href: '/challenges', label: 'Challenges', icon: Swords },
      { href: '/matches', label: 'Matches', icon: Target },
      { href: '/sessions', label: 'Sessions', icon: CalendarDays },
      { href: '/tournaments', label: 'Tournaments', icon: Trophy },
      { href: '/seasons', label: 'Seasons', icon: Medal },
    ],
  },
  {
    title: 'Other',
    items: [
      { href: '/announcements', label: 'Announcements', icon: Megaphone },
      { href: '/varsity', label: 'Varsity', icon: GraduationCap },
      { href: '/audit', label: 'Audit Log', icon: ScrollText },
      { href: '/settings', label: 'Settings', icon: Settings },
    ],
  },
];

export function Sidebar() {
  const pathname = usePathname();
  const [collapsed, setCollapsed] = useState(false);

  return (
    <aside
      className={cn(
        'fixed left-0 top-0 bottom-0 bg-[var(--bg-elevated)] border-r border-[var(--border)] flex flex-col z-40 transition-all duration-300',
        collapsed ? 'w-[72px]' : 'w-64'
      )}
    >
      {/* Header */}
      <div className={cn('p-4 border-b border-[var(--border)] flex items-center', collapsed ? 'justify-center' : 'justify-between')}>
        {!collapsed && (
          <div>
            <h1 className="text-lg font-bold text-[var(--color-accent)] font-display tracking-wider">SFU BADMINTON</h1>
            <p className="text-[10px] text-[var(--text-muted)] uppercase tracking-widest mt-0.5">Admin Panel</p>
          </div>
        )}
        {collapsed && (
          <div className="w-9 h-9 rounded-lg bg-[var(--color-accent)] flex items-center justify-center">
            <span className="text-white font-bold font-display text-sm">SB</span>
          </div>
        )}
        <button
          onClick={() => setCollapsed(!collapsed)}
          className={cn(
            'p-1.5 rounded-md text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--border-hover)] transition-colors',
            collapsed && 'hidden'
          )}
        >
          <ChevronLeft className="w-4 h-4" />
        </button>
      </div>

      {/* Navigation */}
      <nav className="flex-1 py-3 overflow-y-auto space-y-4">
        {navSections.map((section) => (
          <div key={section.title}>
            {!collapsed && (
              <p className="px-5 mb-1.5 text-[10px] font-semibold text-[var(--text-muted)] uppercase tracking-widest">
                {section.title}
              </p>
            )}
            <div className="space-y-0.5 px-2">
              {section.items.map((item) => {
                const isActive = pathname.startsWith(item.href);
                const Icon = item.icon;
                return (
                  <Link
                    key={item.href}
                    href={item.href}
                    title={collapsed ? item.label : undefined}
                    className={cn(
                      'flex items-center gap-3 rounded-lg text-sm transition-all duration-200 group relative',
                      collapsed ? 'justify-center px-2 py-2.5' : 'px-3 py-2.5',
                      isActive
                        ? 'bg-[var(--color-accent)]/10 text-[var(--color-accent)]'
                        : 'text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-white/[0.04]'
                    )}
                  >
                    {isActive && (
                      <span className="absolute left-0 top-1/2 -translate-y-1/2 w-[3px] h-5 rounded-r-full bg-[var(--color-accent)]" />
                    )}
                    <Icon className={cn('w-[18px] h-[18px] flex-shrink-0', isActive && 'text-[var(--color-accent)]')} />
                    {!collapsed && (
                      <span className="font-medium">{item.label}</span>
                    )}
                  </Link>
                );
              })}
            </div>
          </div>
        ))}
      </nav>

      {/* Footer */}
      {!collapsed && (
        <div className="p-4 border-t border-[var(--border)]">
          <div className="flex items-center gap-2 text-[10px] text-[var(--text-muted)]">
            <div className="w-2 h-2 rounded-full bg-[var(--color-success)] animate-pulse" />
            <span>System Online</span>
          </div>
        </div>
      )}

      {/* Expand button when collapsed */}
      {collapsed && (
        <div className="p-3 border-t border-[var(--border)] flex justify-center">
          <button
            onClick={() => setCollapsed(false)}
            className="p-1.5 rounded-md text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--border-hover)] transition-colors"
          >
            <ChevronLeft className="w-4 h-4 rotate-180" />
          </button>
        </div>
      )}
    </aside>
  );
}
