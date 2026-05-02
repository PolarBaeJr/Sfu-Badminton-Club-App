'use client';

import { usePathname } from 'next/navigation';

export function MainContent({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const isPublicRoute =
    pathname === '/login' ||
    pathname.startsWith('/auth') ||
    pathname === '/unauthorized';

  if (isPublicRoute) {
    return <>{children}</>;
  }

  return (
    <main
      className="min-h-screen"
      style={{
        paddingTop: 96,
        animation: 'fadeUp 240ms ease-out',
      }}
    >
      {children}
    </main>
  );
}
