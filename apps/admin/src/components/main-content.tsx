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
    <main className="md:ml-[220px] min-h-screen p-6 pt-16 md:pt-6 lg:p-8 transition-all duration-300">
      <div className="max-w-7xl mx-auto">
        {children}
      </div>
    </main>
  );
}
