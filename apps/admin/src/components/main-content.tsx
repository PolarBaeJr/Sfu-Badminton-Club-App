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

  return (
    <main className="min-h-screen p-6 lg:p-8">
      <div className="max-w-7xl mx-auto">
        {children}
      </div>
    </main>
  );
}
