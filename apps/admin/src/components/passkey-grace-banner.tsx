'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { withBase } from '@/lib/base-path';
import { isChromelessRoute } from '@/lib/chromeless-routes';
import { graceDaysText } from '@/lib/passkey/grace';

// "No console passkey yet, N days left." Fetched once on mount from
// /api/passkey/grace, so no server render pays for it. Shown only while the
// 14-day window (00262) is open; once it ends the middleware takes over.
export function PasskeyGraceBanner() {
  const pathname = usePathname();
  const [daysLeft, setDaysLeft] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch(withBase('/api/passkey/grace'), { cache: 'no-store' })
      .then((res) => (res.ok ? res.json() : null))
      .then((body: { state?: string; daysLeft?: number } | null) => {
        if (cancelled) return;
        if (body?.state === 'grace' && typeof body.daysLeft === 'number') setDaysLeft(body.daysLeft);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  if (daysLeft === null || isChromelessRoute(pathname)) return null;
  return (
    <div
      role="status"
      className="mb-6 rounded-[8px] border border-[var(--line)] bg-[var(--surface-2)] px-4 py-3 text-[14px] text-[var(--ink-2)]"
    >
      No console passkey yet. You have {graceDaysText(daysLeft)} left to add one in{' '}
      <Link href="/settings" className="font-semibold text-[var(--ink)] underline">
        Settings
      </Link>
      . After that the console will ask for one.
    </div>
  );
}
