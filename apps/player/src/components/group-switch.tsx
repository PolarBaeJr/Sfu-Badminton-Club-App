'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { cn, isRouteActive } from '@badminton/ui';
import { mobileSlots } from '@/lib/nav-entries';
import { ALL_FEATURES_ENABLED, type FeatureFlags, type FeatureId } from '@badminton/shared/src/utils/features';

/** Phone only: the pages behind a grouped tab (Events) as a segmented switch at
 * the top of each. The tab itself goes straight to the first page, the way a
 * native tab does, so this is how a member crosses to the others. Renders
 * nothing off a group's pages, or when only one of its pages is visible. */
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
  const group = mobileSlots(isApproved, features, featureAccess)
    .flatMap((slot) => (slot.kind === 'group' ? [slot.group] : []))
    .find((g) => g.items.some((item) => isRouteActive(pathname, item.href)));
  if (!group || group.items.length < 2) return null;

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
