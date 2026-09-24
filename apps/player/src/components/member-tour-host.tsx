'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { usePathname } from 'next/navigation';
import * as Sentry from '@sentry/nextjs';
import { Tour, selectSteps, shouldAutoStart, type TourFinishReason } from '@badminton/ui';
import { tourSeenStorageKey } from '@badminton/shared/src/utils/tours';
import type { FeatureFlags, FeatureId } from '@badminton/shared/src/utils/features';
import { MEMBER_TOUR_KEY, MEMBER_TOUR_STEPS } from '@/lib/tours/member-tour';
import { markMemberTourSeen } from '@/lib/actions/tour';

// Starts the member tour the first time an approved member lands on the feed,
// and replays it from Settings (/feed?tour=member).
//
// A pending signup never gets it by itself: most of what it points at is not
// theirs yet. They can still replay it, and get the steps they can use.
//
// Never over a gate. `blocked` is true while the waiver or deletion screen owns
// the page, and the tour waits until it is gone.

const STORAGE_KEY = tourSeenStorageKey(MEMBER_TOUR_KEY);
const NO_CAPABILITIES: ReadonlySet<string> = new Set();

const LABELS = {
  next: 'Next',
  back: 'Back',
  done: 'Done',
  skip: 'Skip tour',
  progress: (step: number, total: number) => `Step ${step} of ${total}`,
};

const CLASS_NAMES = {
  popover: 'bg-[var(--surface)] border border-[var(--line)] rounded-[16px] p-5 shadow-xl text-[var(--ink)]',
  primary: 'btn btn-primary',
  secondary: 'btn btn-ghost',
  spotlight: 'rounded-[8px]',
};

export function MemberTourHost({
  toursSeen,
  features,
  featureAccess,
  approved,
  blocked,
}: {
  toursSeen: Record<string, unknown>;
  features: FeatureFlags;
  featureAccess: FeatureId[];
  approved: boolean;
  blocked: boolean;
}) {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  // A replay from Settings. It never writes: the first run already did.
  const replayRef = useRef(false);
  const toursSeenRef = useRef(toursSeen);
  toursSeenRef.current = toursSeen;

  // Keyed by value: the layout sends fresh objects on every server render, and
  // a new steps array would send the open tour back to look its target up.
  const featuresKey = JSON.stringify(features);
  const accessKey = featureAccess.join(',');
  const steps = useMemo(
    () => selectSteps(MEMBER_TOUR_STEPS, { features, featureAccess, approved, held: NO_CAPABILITIES }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [featuresKey, accessKey, approved],
  );

  // Read in an effect keyed on the path rather than through useSearchParams,
  // which would opt the whole root layout out of static rendering.
  useEffect(() => {
    if (open || steps.length === 0) return;
    const forced = new URLSearchParams(window.location.search).get('tour') === 'member';
    let localSeen = false;
    try {
      localSeen = localStorage.getItem(STORAGE_KEY) !== null;
    } catch {
      // Private browsing can throw. The server's record still applies.
    }
    const start = shouldAutoStart({
      tourKey: MEMBER_TOUR_KEY,
      toursSeen: toursSeenRef.current,
      localSeen,
      pathname,
      startPaths: ['/feed'],
      blocked,
      forced,
    });
    if (!start || (!forced && !approved)) return;
    replayRef.current = forced;
    setOpen(true);
  }, [pathname, blocked, approved, open, steps.length]);

  const finish = useCallback((_reason: TourFinishReason) => {
    setOpen(false);
    try {
      localStorage.setItem(STORAGE_KEY, new Date().toISOString());
    } catch {
      // Non-fatal: the server write below is the record that matters.
    }
    const url = new URL(window.location.href);
    if (url.searchParams.has('tour')) {
      url.searchParams.delete('tour');
      window.history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`);
    }
    if (replayRef.current) return;
    // Swallowed: a member who has just closed the tour must not see an error
    // about it. The device copy above stops it starting again here.
    markMemberTourSeen().catch((err) => Sentry.captureException(err));
  }, []);

  return (
    <Tour
      open={open}
      steps={steps}
      onFinish={finish}
      labels={LABELS}
      classNames={CLASS_NAMES}
      reserveBottom=".mobile-tabbar"
    />
  );
}
