'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import * as Sentry from '@sentry/nextjs';
import {
  Tour,
  parseTourProgress,
  selectSteps,
  serializeTourProgress,
  shouldAutoStart,
  type TourFinishReason,
} from '@badminton/ui';
import { tourProgressStorageKey, tourSeenStorageKey } from '@badminton/shared/src/utils/tours';
import type { FeatureFlags, FeatureId } from '@badminton/shared/src/utils/features';
import { MEMBER_TOUR_KEY, memberTourSteps } from '@/lib/tours/member-tour';
import { markMemberTourSeen } from '@/lib/actions/tour';

// Starts the member tour the first time an approved member lands on the feed,
// and replays it from Settings (/feed?tour=member).
//
// A pending signup never gets it by itself: most of what it points at is not
// theirs yet. They can still replay it, and get the steps they can use.
//
// Never over a gate. `blocked` is true while the waiver or deletion screen owns
// the page, and the tour waits until it is gone. A gate that appears mid-tour
// closes it, without marking it seen.
//
// The tour opens each step's page through the router. Skip or Done leave the
// member on whatever page they are on.
//
// A reload mid-tour resumes it at the same step: the place is kept in
// sessionStorage (per tab, for half an hour) and removed when the tour ends.

const STORAGE_KEY = tourSeenStorageKey(MEMBER_TOUR_KEY);
const PROGRESS_KEY = tourProgressStorageKey(MEMBER_TOUR_KEY);
const NO_CAPABILITIES: ReadonlySet<string> = new Set();

const LABELS = {
  next: 'Next',
  back: 'Back',
  done: 'Done',
  skip: 'Skip tour',
  progress: (step: number, total: number) => `Step ${step} of ${total}`,
};

const CLASS_NAMES = {
  popover: 'bg-[var(--surface)] border border-[var(--line)] rounded-[16px] p-5 md:p-7 shadow-xl text-[var(--ink)]',
  primary: 'btn btn-primary',
  secondary: 'btn btn-ghost',
  spotlight: 'rounded-[8px] [--tour-ring:var(--red)]',
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
  const router = useRouter();
  const [open, setOpen] = useState(false);
  // A replay from Settings. It never writes: the first run already did.
  const replayRef = useRef(false);
  // Where a resumed tour opens. Used by one open, then cleared, so a later
  // replay from Settings starts at the first step.
  const resumeRef = useRef<{ index: number; startPath: string } | null>(null);
  const toursSeenRef = useRef(toursSeen);
  toursSeenRef.current = toursSeen;

  // Keyed by value: the layout sends fresh objects on every server render, and
  // a new steps array would send the open tour back to look its target up.
  const featuresKey = JSON.stringify(features);
  const accessKey = featureAccess.join(',');
  const steps = useMemo(
    () => {
      const ctx = { features, featureAccess, approved, held: NO_CAPABILITIES };
      return selectSteps(memberTourSteps(ctx), ctx);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [featuresKey, accessKey, approved],
  );

  // Read in an effect keyed on the path rather than through useSearchParams,
  // which would opt the whole root layout out of static rendering.
  useEffect(() => {
    if (open || steps.length === 0) return;
    // A tour open when the page reloaded wins over everything below,
    // including ?tour=.
    let raw: string | null = null;
    try {
      raw = sessionStorage.getItem(PROGRESS_KEY);
    } catch {
      // Storage unavailable: nothing to resume.
    }
    const saved = parseTourProgress(raw, {
      tourKey: MEMBER_TOUR_KEY,
      stepIds: steps.map((s) => s.id),
      now: Date.now(),
    });
    if (!saved && raw !== null) {
      try {
        sessionStorage.removeItem(PROGRESS_KEY);
      } catch {
        // Non-fatal: it is refused again next time.
      }
    }
    if (saved && !blocked && (saved.replay || approved)) {
      resumeRef.current = { index: saved.index, startPath: saved.startPath };
      replayRef.current = saved.replay;
      setOpen(true);
      return;
    }
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
  }, [pathname, blocked, approved, open, steps]);

  // A gate closing the tour leaves its place saved on purpose: it resumes when
  // the gate lifts, if that is within the half hour.
  useEffect(() => {
    if (open && blocked) setOpen(false);
  }, [open, blocked]);

  // The Tour read the resume point in its own open effect, which runs before
  // this one; clear it so it is used once.
  useEffect(() => {
    if (open) resumeRef.current = null;
  }, [open]);

  const saveProgress = useCallback((info: { index: number; stepId: string; startPath: string }) => {
    try {
      sessionStorage.setItem(
        PROGRESS_KEY,
        serializeTourProgress({
          v: 1,
          key: MEMBER_TOUR_KEY,
          stepId: info.stepId,
          index: info.index,
          startPath: info.startPath,
          replay: replayRef.current,
          savedAt: Date.now(),
        }),
      );
    } catch {
      // Storage unavailable: a reload starts the tour over, as before.
    }
  }, []);

  const finish = useCallback((_reason: TourFinishReason) => {
    try {
      sessionStorage.removeItem(PROGRESS_KEY);
    } catch {
      // Non-fatal: a stale place is refused after half an hour anyway.
    }
    resumeRef.current = null;
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
      pathname={pathname}
      onNavigate={(href) => router.push(href)}
      initialStep={resumeRef.current?.index}
      initialStartPath={resumeRef.current?.startPath}
      onStepChange={saveProgress}
    />
  );
}
