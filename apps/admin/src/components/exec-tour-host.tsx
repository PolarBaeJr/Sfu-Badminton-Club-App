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
import { FEATURES, type FeatureFlags } from '@badminton/shared/src/utils/features';
import { featureAccessCapability, type AccessLevel } from '@badminton/shared/src/utils/access-level';
import { EXEC_TOUR_KEY, execTourMayAutoStart, execTourSteps } from '@/lib/tours/exec-tour';
import { markConsoleTourSeen } from '@/lib/actions/tour';
import { BASE_PATH } from '@/lib/base-path';
import { isChromelessRoute } from '@/lib/chromeless-routes';

// Starts the console tour the first time an officer opens the console, on
// whichever page they land, and replays it from Settings (?tour=exec). The tour
// opens each step's page through the router, which applies the base path, and
// Skip or Done leave the reader on whatever page they are on.
//
// Never by itself for a trainer: their console is the roster and varsity
// notes, and almost nothing the tour points at is theirs. They can still replay
// it and get the steps they hold.
//
// A reload mid-tour resumes it at the same step, the same way the member tour
// does: the place is kept in sessionStorage and removed when the tour ends.

const STORAGE_KEY = tourSeenStorageKey(EXEC_TOUR_KEY);
const PROGRESS_KEY = tourProgressStorageKey(EXEC_TOUR_KEY);

const LABELS = {
  next: 'Next',
  back: 'Back',
  done: 'Done',
  skip: 'Skip tour',
  progress: (step: number, total: number) => `Step ${step} of ${total}`,
};

const BUTTON = 'inline-flex items-center justify-center font-bold uppercase tracking-[0.16em] text-[11px] rounded-[8px] border transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]';

const CLASS_NAMES = {
  popover: 'bg-[var(--bg-elevated)] border border-[var(--border)] rounded-[16px] p-5 md:p-7 shadow-xl text-[var(--text-primary)]',
  primary: `${BUTTON} bg-[var(--color-accent)] text-white border-transparent hover:brightness-110`,
  secondary: `${BUTTON} bg-transparent text-[var(--text-muted)] border-[var(--border)] hover:text-[var(--text-primary)]`,
  spotlight: 'rounded-[8px] [--tour-ring:var(--red)]',
};

// The pages the sidebar renders nothing on.
const isPublicRoute = isChromelessRoute;

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
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const replayRef = useRef(false);
  // Where a resumed tour opens. Used by one open, then cleared.
  const resumeRef = useRef<{ index: number; startPath: string } | null>(null);
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
    // A tour open when the page reloaded wins over everything below.
    let raw: string | null = null;
    try {
      raw = sessionStorage.getItem(PROGRESS_KEY);
    } catch {
      // Storage unavailable: nothing to resume.
    }
    const saved = parseTourProgress(raw, {
      tourKey: EXEC_TOUR_KEY,
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
    if (saved && (saved.replay || execTourMayAutoStart(level))) {
      resumeRef.current = { index: saved.index, startPath: saved.startPath };
      replayRef.current = saved.replay;
      setOpen(true);
      return;
    }
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
  }, [pathname, level, open, steps]);

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
          key: EXEC_TOUR_KEY,
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
    // window.location already carries the base path, so this needs no withBase.
    const url = new URL(window.location.href);
    if (url.searchParams.has('tour')) {
      url.searchParams.delete('tour');
      window.history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`);
    }
    if (replayRef.current) return;
    markConsoleTourSeen().catch((err) => Sentry.captureException(err));
  }, []);

  return (
    <Tour
      open={open}
      steps={steps}
      onFinish={finish}
      labels={LABELS}
      classNames={CLASS_NAMES}
      pathname={pathname}
      onNavigate={(href) => router.push(href)}
      basePath={BASE_PATH}
      initialStep={resumeRef.current?.index}
      initialStartPath={resumeRef.current?.startPath}
      onStepChange={saveProgress}
    />
  );
}
