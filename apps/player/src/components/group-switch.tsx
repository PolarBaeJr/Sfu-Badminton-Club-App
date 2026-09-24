'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { cn, isRouteActive } from '@badminton/ui';
import { mobileSlots } from '@/lib/nav-entries';
import { ALL_FEATURES_ENABLED, type FeatureFlags, type FeatureId } from '@badminton/shared/src/utils/features';

/** Phone only: the pages behind a grouped tab (Events) as a segmented switch at
 * the top of each, and a sideways swipe on the page moves to the next or
 * previous one. Renders nothing off a group's pages, or when only one of its
 * pages is visible. */
export function GroupSwitch({
  isApproved,
  features = ALL_FEATURES_ENABLED,
  featureAccess = [],
}: {
  isApproved: boolean;
  features?: FeatureFlags;
  featureAccess?: readonly FeatureId[];
}) {
  const pathname = usePathname();
  const router = useRouter();
  const group = mobileSlots(isApproved, features, featureAccess)
    .flatMap((slot) => (slot.kind === 'group' ? [slot.group] : []))
    .find((g) => g.items.some((item) => isRouteActive(pathname, item.href)));
  const hrefs = group && group.items.length >= 2 ? group.items.map((i) => i.href) : null;
  const key = hrefs?.join(' ');

  useEffect(() => {
    if (!hrefs) return;
    const at = hrefs.findIndex((href) => isRouteActive(pathname, href));
    let start: { x: number; y: number } | null = null;
    const onStart = (e: TouchEvent) => {
      const t = e.touches[0];
      // Not from the screen edge, which iOS Safari keeps for back and forward;
      // not with two fingers; and not on anything that scrolls or edits sideways.
      const el = e.target instanceof Element ? e.target : null;
      start =
        t && e.touches.length === 1 && t.clientX > 24 && t.clientX < window.innerWidth - 24 &&
        !el?.closest('input, textarea, select, [contenteditable], [data-no-swipe], .overflow-x-auto')
          ? { x: t.clientX, y: t.clientY }
          : null;
    };
    const onEnd = (e: TouchEvent) => {
      const t = e.changedTouches[0];
      if (!start || !t) return;
      const dx = t.clientX - start.x;
      const dy = t.clientY - start.y;
      start = null;
      // A deliberate sideways swipe: far enough, and mostly horizontal.
      if (Math.abs(dx) < 70 || Math.abs(dx) < Math.abs(dy) * 2) return;
      const next = hrefs[at + (dx < 0 ? 1 : -1)];
      if (next) router.push(next);
    };
    document.addEventListener('touchstart', onStart, { passive: true });
    document.addEventListener('touchend', onEnd, { passive: true });
    return () => {
      document.removeEventListener('touchstart', onStart);
      document.removeEventListener('touchend', onEnd);
    };
    // key stands in for hrefs, which is a new array every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, pathname, router]);

  if (!group || !hrefs) return null;

  return (
    <nav className="group-switch" aria-label={group.label}>
      {group.items.map((item) => {
        const current = isRouteActive(pathname, item.href);
        return (
          <Link
            key={item.href}
            href={item.href}
            className={cn('press', current && 'active')}
            aria-current={current ? 'page' : undefined}
          >
            {item.label}
          </Link>
        );
      })}
    </nav>
  );
}
