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

  // Full width, deliberately.
  //
  // This was a centred max-w-7xl (1280px) column. Two things were wrong with it.
  // The nav bar above has never had a cap — it runs edge to edge — so on any
  // display wider than 1280 the console's own header did not line up with the
  // content beneath it. And almost every page here is a TABLE or a bracket,
  // whose useful width is set by how many columns the data has, not by how long
  // a line of prose should be; a roster of 100 players was being scrolled inside
  // a 1280px box on a 2560px monitor with a third of the screen left blank.
  //
  // The player app makes the same choice through its own --page-max token, so
  // the two halves of the product read the same way. If a page of long-form
  // prose ever needs a reading measure, cap it in THAT page rather than
  // reinstating a cap here — the shell should not decide it for everyone.
  return (
    <main className="min-h-screen p-6 lg:p-8">
      {children}
    </main>
  );
}
