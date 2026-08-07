'use client';

import { usePathname } from 'next/navigation';

export function MainContent({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const isPublicRoute =
    pathname === '/login' ||
    pathname.startsWith('/auth') ||
    pathname === '/unauthorized' ||
    pathname === '/unavailable';

  if (isPublicRoute) {
    return <>{children}</>;
  }

  // The event page carries a bracket, which is the one thing in this console
  // whose natural width is set by the DATA rather than by readability — a
  // 128-slot draw is seven columns wide no matter how the page is styled.
  // Holding it inside a 1280px reading column on a wide monitor means scrolling
  // sideways through a diagram the screen could have shown at once.
  const isWideRoute = /^\/tournaments\/[^/]+\/events\/[^/]+$/.test(pathname);

  return (
    <main className="min-h-screen p-6 lg:p-8">
      {/* Deliberately the real available width rather than a 100vw break-out:
          vw includes the scrollbar, so a full-bleed child overflows the page by
          its width and adds a horizontal scrollbar to every route it touches. */}
      <div className={isWideRoute ? 'w-full' : 'max-w-7xl mx-auto'}>
        {children}
      </div>
    </main>
  );
}
