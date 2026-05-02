'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';
import { cn, NavBadge } from '@badminton/ui';
import { createClient } from '@badminton/shared/supabase-browser';

type Props = { userEmail?: string | null };

const PRIMARY = [
  { href: '/dashboard',     label: 'Dashboard' },
  { href: '/players',       label: 'Players' },
  { href: '/sessions',      label: 'Sessions' },
  { href: '/matches',       label: 'Matches' },
  { href: '/announcements', label: 'Announcements' },
  { href: '/disputes',      label: 'Disputes' },
] as const;

const SECONDARY = [
  { href: '/seasons',  label: 'Seasons' },
  { href: '/audit',    label: 'Audit Log' },
  { href: '/settings', label: 'Settings' },
] as const;

export function Sidebar({ userEmail = null }: Props = {}) {
  const pathname = usePathname();
  const [mobileOpen, setMobileOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);

  const isPublicRoute =
    pathname === '/login' ||
    pathname.startsWith('/auth') ||
    pathname === '/unauthorized';

  useEffect(() => {
    setMobileOpen(false);
    setSearchOpen(false);
  }, [pathname]);

  useEffect(() => {
    if (typeof document === 'undefined') return;
    document.body.classList.toggle('no-scroll', mobileOpen);
    return () => document.body.classList.remove('no-scroll');
  }, [mobileOpen]);

  if (isPublicRoute) return null;

  const isActive = (href: string) =>
    pathname === href || pathname.startsWith(href + '/');

  const initials = (userEmail ?? 'AU').slice(0, 2).toUpperCase();

  async function handleSignOut() {
    const supabase = createClient();
    await supabase.auth.signOut();
    window.location.href = '/login';
  }

  return (
    <>
      <div
        className="fixed top-0 left-0 right-0 z-50"
        style={{ background: 'var(--surface1)' }}
      >
        {/* Primary topbar */}
        <header
          className="flex items-center px-6 gap-8"
          style={{ height: 56, borderBottom: '1px solid var(--hairline)' }}
        >
          {/* Hamburger (mobile) */}
          <button
            type="button"
            aria-label="Open menu"
            onClick={() => setMobileOpen(true)}
            className="md:hidden flex flex-col items-center justify-center w-8 h-8 gap-[5px]"
          >
            <span className="block" style={{ width: 18, height: 1.5, background: 'var(--ink)' }} />
            <span className="block" style={{ width: 18, height: 1.5, background: 'var(--ink)' }} />
            <span className="block" style={{ width: 18, height: 1.5, background: 'var(--ink)' }} />
          </button>

          {/* Brand */}
          <Link href="/dashboard" className="flex items-center gap-3 flex-shrink-0">
            <span
              className="flex items-center justify-center"
              style={{
                width: 28, height: 28,
                background: 'var(--red)',
                color: '#fff',
                fontFamily: 'var(--font-display)',
                fontWeight: 800,
                fontSize: 16,
              }}
            >S</span>
            <span
              className="uppercase font-bold"
              style={{
                fontFamily: 'var(--font-display)',
                fontSize: 13,
                letterSpacing: '0.18em',
                color: 'var(--ink)',
              }}
            >
              SFU Badminton
              <span style={{ color: 'var(--muted)' }}> · Admin</span>
            </span>
          </Link>

          {/* Primary nav */}
          <nav className="hidden md:flex items-center gap-8 flex-1">
            {PRIMARY.map((item) => (
              <Link
                key={item.href}
                href={item.href}
                className={cn(
                  'relative inline-flex items-center gap-2 uppercase font-semibold py-[19px]',
                  'transition-colors duration-150 ease-out',
                )}
                style={{
                  fontSize: 11,
                  letterSpacing: '0.12em',
                  color: isActive(item.href) ? 'var(--ink)' : 'var(--muted)',
                }}
              >
                <span className="inline-flex items-center gap-2">
                  {item.label}
                </span>
                {isActive(item.href) && (
                  <span
                    aria-hidden
                    className="absolute left-0 right-0 bottom-0"
                    style={{ height: 2, background: 'var(--red)' }}
                  />
                )}
              </Link>
            ))}
          </nav>

          {/* Right cluster */}
          <div className="flex items-center gap-4 flex-shrink-0 ml-auto">
            <div className={cn('flex items-center', searchOpen && 'open')}>
              <input
                type="search"
                placeholder="SEARCH"
                aria-label="Search"
                className="bg-[var(--bg)] uppercase outline-none"
                style={{
                  border: '1px solid var(--hairline)',
                  color: 'var(--ink)',
                  fontSize: 12,
                  letterSpacing: '0.18em',
                  width: searchOpen ? 240 : 0,
                  padding: searchOpen ? '7px 12px' : '7px 0',
                  opacity: searchOpen ? 1 : 0,
                  marginRight: searchOpen ? 8 : 0,
                  transition: 'width 200ms ease-out, padding 200ms ease-out, opacity 200ms ease-out',
                }}
              />
              <button
                type="button"
                aria-label="Toggle search"
                onClick={() => setSearchOpen((v) => !v)}
                className="w-8 h-8 flex items-center justify-center transition-colors duration-150"
                style={{ color: 'var(--muted)' }}
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6">
                  <circle cx="11" cy="11" r="7" />
                  <line x1="21" y1="21" x2="16.5" y2="16.5" />
                </svg>
              </button>
            </div>
            <button
              type="button"
              aria-label="Notifications"
              className="relative w-8 h-8 flex items-center justify-center"
              style={{ color: 'var(--muted)' }}
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6">
                <path d="M6 8a6 6 0 1 1 12 0c0 7 3 8 3 8H3s3-1 3-8" />
                <path d="M10 20a2 2 0 0 0 4 0" />
              </svg>
              <span
                aria-hidden
                className="absolute"
                style={{ top: 6, right: 6, width: 6, height: 6, background: 'var(--red)' }}
              />
            </button>
            <button
              type="button"
              onClick={handleSignOut}
              title={userEmail ?? 'Sign out'}
              className="flex items-center justify-center"
              style={{
                width: 32, height: 32,
                background: 'var(--surface3)',
                color: 'var(--ink)',
                fontFamily: 'var(--font-display)',
                fontWeight: 700,
                fontSize: 12,
                letterSpacing: '0.05em',
              }}
            >{initials}</button>
          </div>
        </header>

        {/* Secondary bar */}
        <div
          className="hidden md:flex items-center px-6 gap-7"
          style={{
            height: 36,
            background: '#0A0A0A',
            borderTop: '1px solid rgba(255,255,255,0.04)',
            borderBottom: '1px solid var(--hairline)',
          }}
        >
          {SECONDARY.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className="relative inline-flex items-center uppercase font-semibold transition-colors duration-150"
              style={{
                height: 36,
                fontSize: 10,
                letterSpacing: '0.18em',
                color: isActive(item.href) ? '#F0F0F0' : '#3A3A3A',
              }}
            >
              {item.label}
              {isActive(item.href) && (
                <span
                  aria-hidden
                  className="absolute left-0 right-0 bottom-0"
                  style={{ height: 2, background: 'var(--red)' }}
                />
              )}
            </Link>
          ))}
          <span
            className="ml-auto uppercase"
            style={{ color: 'var(--dim)', fontSize: 10, letterSpacing: '0.18em' }}
          >
            <span
              aria-hidden
              className="inline-block align-middle"
              style={{
                width: 6, height: 6, background: 'var(--red)', marginRight: 8,
                animation: 'pulse 1.6s ease-in-out infinite',
              }}
            />
            Season 02 · Spring 2026 · Live
          </span>
        </div>
      </div>

      {/* Mobile overlay */}
      <div
        className={cn(
          'md:hidden fixed inset-0 z-[100] flex flex-col',
          'transition-transform duration-[250ms]',
        )}
        style={{
          background: 'var(--surface1)',
          transform: mobileOpen ? 'translateX(0)' : 'translateX(-100%)',
          transitionTimingFunction: 'cubic-bezier(0.4,0,0.2,1)',
        }}
        aria-hidden={!mobileOpen}
      >
        <div
          className="flex items-center justify-between px-6"
          style={{ height: 56, borderBottom: '1px solid var(--hairline)' }}
        >
          <span className="flex items-center gap-3">
            <span
              className="flex items-center justify-center"
              style={{
                width: 28, height: 28,
                background: 'var(--red)', color: '#fff',
                fontFamily: 'var(--font-display)', fontWeight: 800, fontSize: 16,
              }}
            >S</span>
            <span
              className="uppercase font-bold"
              style={{ fontFamily: 'var(--font-display)', fontSize: 13, letterSpacing: '0.18em', color: 'var(--ink)' }}
            >SFU Badminton</span>
          </span>
          <button
            type="button"
            aria-label="Close menu"
            onClick={() => setMobileOpen(false)}
            style={{ color: 'var(--ink)', fontSize: 28, lineHeight: 1, width: 32, height: 32 }}
          >×</button>
        </div>
        <div className="px-6 pt-5 pb-2 uppercase" style={{ fontSize: 9, letterSpacing: '0.2em', color: 'var(--faint)' }}>Primary</div>
        <nav className="flex flex-col">
          {PRIMARY.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className="flex items-center px-6 uppercase font-semibold"
              style={{
                minHeight: 52,
                fontSize: 12,
                letterSpacing: '0.14em',
                color: isActive(item.href) ? 'var(--ink)' : 'var(--text)',
                borderBottom: '1px solid var(--hairline)',
                borderLeft: isActive(item.href) ? '3px solid var(--red)' : '3px solid transparent',
              }}
            >
              {item.label}
            </Link>
          ))}
        </nav>
        <div className="px-6 pt-5 pb-2 uppercase" style={{ fontSize: 9, letterSpacing: '0.2em', color: 'var(--faint)' }}>Secondary</div>
        <nav className="flex flex-col">
          {SECONDARY.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className="flex items-center px-6 uppercase font-semibold"
              style={{
                minHeight: 52,
                fontSize: 12,
                letterSpacing: '0.14em',
                color: isActive(item.href) ? 'var(--ink)' : 'var(--text)',
                borderBottom: '1px solid var(--hairline)',
                borderLeft: isActive(item.href) ? '3px solid var(--red)' : '3px solid transparent',
              }}
            >
              {item.label}
            </Link>
          ))}
        </nav>
        <div className="mt-auto px-6 py-5 flex items-center justify-between" style={{ borderTop: '1px solid var(--hairline)' }}>
          <span className="uppercase" style={{ fontSize: 10, letterSpacing: '0.18em', color: 'var(--muted)' }}>
            {userEmail ?? 'Signed in'}
          </span>
          <button
            type="button"
            onClick={handleSignOut}
            className="uppercase font-semibold"
            style={{ fontSize: 10, letterSpacing: '0.18em', color: 'var(--red)' }}
          >Sign out</button>
        </div>
      </div>
      {/* NavBadge import is intentional even if unused above; reserved for future per-link counts. */}
      <span hidden><NavBadge count={0} /></span>
    </>
  );
}
