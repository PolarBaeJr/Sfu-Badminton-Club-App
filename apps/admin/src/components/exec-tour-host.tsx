'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { usePathname } from 'next/navigation';
import * as Sentry from '@sentry/nextjs';
import { Tour, selectSteps, shouldAutoStart, type TourFinishReason } from '@badminton/ui';
import { tourSeenStorageKey } from '@badminton/shared/src/utils/tours';
import { FEATURES, type FeatureFlags } from '@badminton/shared/src/utils/features';
import { featureAccessCapability, type AccessLevel } from '@badminton/shared/src/utils/access-level';
import { EXEC_TOUR_KEY, execTourMayAutoStart, execTourSteps } from '@/lib/tours/exec-tour';
import { markConsoleTourSeen } from '@/lib/actions/tour';

// Starts the console tour the first time an officer opens the console, on
// whichever page they land, and replays it from Settings (?tour=exec).
//
// Never by itself for a trainer: their console is the roster and varsity
// notes, and almost nothing the tour points at is theirs. They can still replay
// it and get the steps they hold.

const STORAGE_KEY = tourSeenStorageKey(EXEC_TOUR_KEY);

const LABELS = {
  next: 'Next',
  back: 'Back',
  done: 'Done',
  skip: 'Skip tour',
  progress: (step: number, total: number) => `Step ${step} of ${total}`,
};

const BUTTON = 'inline-flex items-center justify-center font-bold uppercase tracking-[0.16em] text-[11px] rounded-[8px] border transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]';

const CLASS_NAMES = {
  popover: 'bg-[var(--bg-elevated)] border border-[var(--border)] rounded-[16px] p-5 shadow-xl text-[var(--text-primary)]',
  primary: `${BUTTON} bg-[var(--color-accent)] text-white border-transparent hover:brightness-110`,
  secondary: `${BUTTON} bg-transparent text-[var(--text-muted)] border-[var(--border)] hover:text-[var(--text-primary)]`,
  spotlight: 'rounded-[8px]',
};

// The same four the sidebar renders nothing on.
function isPublicRoute(pathname: string): boolean {
  return (
    pathname === '/login' ||
    pathname.startsWith('/auth') ||
    pathname === '/unauthorized' ||
    pathname === '/unavailable'
  );
}

export function ExecTourHost({
  level,
  held,
  toursSeen,
  features,
}: {
  level: AccessLevel | null;
  /** effectiveCapabilities(), as an array: a Set does not cross from the server layout. */
  held: string[];
  toursSeen: Record<string, unknown>;
  features: FeatureFlags;
}) {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const replayRef = useRef(false);
  const toursSeenRef = useRef(toursSeen);
  toursSeenRef.current = toursSeen;

  // Keyed by value, for the reason the member tour host gives.
  const heldKey = held.join(',');
  const featuresKey = JSON.stringify(features);
  const steps = useMemo(() => {
    const set = new Set(held);
    const featureAccess = FEATURES.filter((f) => set.has(featureAccessCapability(f.id))).map((f) => f.id);
    return selectSteps(execTourSteps(set), { features, featureAccess, approved: true, held: set });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [heldKey, featuresKey]);

  useEffect(() => {
    if (open || level === null || steps.length === 0 || isPublicRoute(pathname)) return;
    const forced = new URLSearchParams(window.location.search).get('tour') === 'exec';
    if (!forced && !execTourMayAutoStart(level)) return;
    let localSeen = false;
    try {
      localSeen = localStorage.getItem(STORAGE_KEY) !== null;
    } catch {
      // Private browsing can throw. The server's record still applies.
    }
    const start = shouldAutoStart({
      tourKey: EXEC_TOUR_KEY,
      toursSeen: toursSeenRef.current,
      localSeen,
      pathname,
      startPaths: '*',
      blocked: false,
      forced,
    });
    if (!start) return;
    replayRef.current = forced;
    setOpen(true);
  }, [pathname, level, open, steps.length]);

  const finish = useCallback((_reason: TourFinishReason) => {
    setOpen(false);
    try {
      localStorage.setItem(STORAGE_KEY, new Date().toISOString());
    } catch {
      // Non-fatal: the server write below is the record that matters.
    }
    // window.location already carries the base path, so this needs no withBase.
    const url = new URL(window.location.href);
    if (url.searchParams.has('tour')) {
      url.searchParams.delete('tour');
      window.history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`);
    }
    if (replayRef.current) return;
    markConsoleTourSeen().catch((err) => Sentry.captureException(err));
  }, []);

  return <Tour open={open} steps={steps} onFinish={finish} labels={LABELS} classNames={CLASS_NAMES} />;
}
