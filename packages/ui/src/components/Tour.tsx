'use client';

import React from 'react';
import { cn } from '../utils';
import { FOCUSABLE } from './Dialog';
import {
  TOUR_NAV_TIMEOUT_MS,
  TOUR_TARGET_TIMEOUT_MS,
  clampRectToViewport,
  effectiveRoutes,
  placePopover,
  resolveTarget,
  routeDecision,
  skipTo,
  stripBasePath,
  targetDecision,
  type TourPlacement,
  type TourRect,
  type TourStep,
} from '../tour';

// A GUIDED TOUR: a card that walks through a list of steps, each pointing at an
// element on the page with a spotlight cut out of a dimmed screen.
//
// Headless-styled, like NavMenu. Each app passes its own tokens through
// `classNames` and every word through `labels`, so nothing here is copy and
// nothing here knows which app it is in. The decisions (which steps, which
// element, where the card goes, when to give up on a page) are the pure
// functions in ../tour.ts.
//
// IT VISITS PAGES. A step with an `href` is shown on that page: the tour asks
// the host to open it (`onNavigate`), waits for `pathname` to arrive and for
// the target to appear, each with a time limit, and skips the step if the page
// redirects away. The host owns the router; nothing here imports next/*. While
// a page loads the card sits centred with the new step's words, so Skip is
// always on screen. A navigation the tour did not ask for (the browser's Back)
// ends it.
//
// NO PORTAL. It is mounted at the top of the body by each app's layout and is
// position: fixed throughout, so it has nothing to escape; and without a portal
// the closed-over shell still renders on the server, which is what the render
// test reads.
//
// z-index 60: above the top bar and tab bar (40) and above Dialog (50).

export type TourFinishReason = 'done' | 'skipped';

export interface TourLabels {
  next: string;
  back: string;
  done: string;
  skip: string;
  /** "Step 3 of 8", read out by the live region and shown on the card. */
  progress: (step: number, total: number) => string;
}

export interface TourProps {
  open: boolean;
  /** Already filtered for this viewer (selectSteps). */
  steps: readonly TourStep[];
  onFinish: (reason: TourFinishReason) => void;
  labels: TourLabels;
  classNames?: {
    popover?: string;
    primary?: string;
    secondary?: string;
    spotlight?: string;
  };
  /** A fixed bar at the bottom of the screen (the phone's tab bar) the card must stay clear of. */
  reserveBottom?: string;
  /** The current app-relative path. Read with onNavigate; without both, step hrefs are ignored. */
  pathname?: string;
  /** Opens a step's page through the host's router. */
  onNavigate?: (href: string) => void;
  /** Stripped from `pathname` before it is compared with a step's href. */
  basePath?: string;
}

const Z_INDEX = 60;
// Breathing room between the spotlight's edge and the element inside it.
const SPOTLIGHT_PAD = 6;
// Only until the card has been laid out once; its real width is read after.
const POPOVER_FALLBACK_WIDTH = 360;
const SCRIM = 'rgba(0, 0, 0, 0.55)';
// A target taller than this share of the screen is scrolled to its top, not its middle.
const TALL_TARGET = 0.6;

function visible(el: Element): boolean {
  if (el.getClientRects().length === 0) return false;
  return window.getComputedStyle(el).visibility !== 'hidden';
}

// Every match, not the first: the same selector can match a hidden copy (the
// top bar's nav on a phone) ahead of the one on screen.
function findVisible(selector: string): Element | null {
  for (const el of Array.from(document.querySelectorAll(selector))) {
    if (visible(el)) return el;
  }
  return null;
}

const isTargetVisible = (selector: string) => findVisible(selector) !== null;

function nextFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

export function Tour({
  open,
  steps,
  onFinish,
  labels,
  classNames,
  reserveBottom,
  pathname,
  onNavigate,
  basePath = '',
}: TourProps) {
  const [index, setIndex] = React.useState(0);
  // The step whose page and target have been settled, and the selector it
  // resolved to (null for a centred card). Until it matches `index` the step
  // is pending: the card is centred with the new step's words and no spotlight.
  const [resolved, setResolved] = React.useState<{ index: number; selector: string | null } | null>(null);
  const [rect, setRect] = React.useState<TourRect | null>(null);
  const [placement, setPlacement] = React.useState<TourPlacement | null>(null);
  const [reducedMotion, setReducedMotion] = React.useState(false);
  // Bumped by a timer, to look at a step still waiting for its page again.
  const [tick, setTick] = React.useState(0);
  const popoverRef = React.useRef<HTMLDivElement>(null);
  const headingRef = React.useRef<HTMLHeadingElement>(null);
  // Which way the reader is moving, so a step with nothing to point at is
  // skipped in the same direction.
  const directionRef = React.useRef<1 | -1>(1);
  // The step the reader pressed Back on: a walk back off the front returns there.
  const backOriginRef = React.useRef<number | null>(null);
  // The navigation the tour started for a step, and whether it reached the page.
  const navRef = React.useRef<{ index: number; fromPath: string; startedAt: number; arrived: boolean } | null>(null);
  // The step on screen and the path it was shown on, so a navigation the tour
  // did not ask for can be told apart from one it did.
  const shownRef = React.useRef<{ index: number; path: string } | null>(null);
  // A ref, not state: the step effect runs in the same commit as the open
  // effect that sets it, and must already see it.
  const startPathRef = React.useRef('');
  const titleId = React.useId();
  const bodyId = React.useId();

  // Held in a ref for the reason Dialog gives: the caller's handler is a new
  // function on every render, and listing it would re-run the effects below.
  const onFinishRef = React.useRef(onFinish);
  onFinishRef.current = onFinish;
  const onNavigateRef = React.useRef(onNavigate);
  onNavigateRef.current = onNavigate;
  const navigates = onNavigate !== undefined && pathname !== undefined;

  React.useEffect(() => {
    const query = window.matchMedia('(prefers-reduced-motion: reduce)');
    setReducedMotion(query.matches);
    const onChange = () => setReducedMotion(query.matches);
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, []);

  // Every open starts at the first step, on the page it was opened on, and
  // focus goes back where it came from when the tour closes. The step is reset
  // on close as well, so the first pass after the next open cannot open the
  // page of the step this one ended on.
  React.useEffect(() => {
    if (!open) return;
    const previouslyFocused = document.activeElement as HTMLElement | null;
    directionRef.current = 1;
    backOriginRef.current = null;
    navRef.current = null;
    shownRef.current = null;
    startPathRef.current = pathname ?? '';
    setIndex(0);
    setResolved(null);
    setPlacement(null);
    return () => {
      setIndex(0);
      setResolved(null);
      setPlacement(null);
      previouslyFocused?.focus?.();
    };
    // pathname is read at open, not reacted to.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // One step at a time: get to its page, then find its target. Every wait has a
  // time limit, and every timer and observer is torn down when the path
  // changes, so the next pass sees a redirect that lands late.
  React.useEffect(() => {
    if (!open || steps.length === 0) return;
    const i = Math.min(index, steps.length - 1);
    const step = steps[i]!;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let frame = 0;
    let observer: MutationObserver | null = null;
    const cleanup = () => {
      cancelled = true;
      clearTimeout(timer);
      if (frame) cancelAnimationFrame(frame);
      observer?.disconnect();
    };

    const skip = () => {
      const next = skipTo({
        index: i,
        direction: directionRef.current,
        length: steps.length,
        backOrigin: backOriginRef.current,
      });
      if (next === 'finish') {
        onFinishRef.current('done');
        return;
      }
      directionRef.current = next.direction;
      setIndex(next.index);
    };

    if (navigates) {
      const path = pathname!;
      const shown = shownRef.current;
      // The reader went somewhere (the browser's Back) while this step was up.
      if (shown && shown.index === i && stripBasePath(path, basePath) !== stripBasePath(shown.path, basePath)) {
        onFinishRef.current('skipped');
        return;
      }
      const route = effectiveRoutes(steps, startPathRef.current)[i]!;
      const nav = navRef.current?.index === i ? navRef.current : null;
      const decision = routeDecision({
        route,
        pathname: path,
        basePath,
        nav: nav && { fromPath: nav.fromPath, arrived: nav.arrived, elapsedMs: Date.now() - nav.startedAt },
        timeoutMs: TOUR_NAV_TIMEOUT_MS,
      });
      if (decision === 'skip') {
        skip();
        return;
      }
      if (decision === 'navigate' || decision === 'wait') {
        let startedAt = nav?.startedAt ?? Date.now();
        if (decision === 'navigate') {
          startedAt = Date.now();
          navRef.current = { index: i, fromPath: path, startedAt, arrived: false };
          onNavigateRef.current?.(route);
        }
        timer = setTimeout(() => setTick((t) => t + 1), Math.max(0, TOUR_NAV_TIMEOUT_MS - (Date.now() - startedAt)));
        return cleanup;
      }
      if (nav) nav.arrived = true;
    }

    let started = Date.now();
    const settle = (selector: string | null) => {
      const el = selector ? findVisible(selector) : null;
      if (el) {
        // A target taller than most of the screen keeps its top in view.
        const tall = el.getBoundingClientRect().height > window.innerHeight * TALL_TARGET;
        el.scrollIntoView({
          block: tall ? 'start' : 'center',
          // Centring inline as well scrolls a horizontal strip to the item on a phone.
          inline: 'center',
          behavior: reducedMotion ? 'auto' : 'smooth',
        });
      }
      shownRef.current = { index: i, path: pathname ?? '' };
      setResolved({ index: i, selector });
    };
    // True once the step is decided.
    const check = (timedOut: boolean): boolean => {
      const selector = resolveTarget(step.targets, isTargetVisible);
      const decision = targetDecision({
        hasTargets: step.targets.length > 0,
        found: selector !== null,
        elapsedMs: timedOut ? TOUR_TARGET_TIMEOUT_MS : Date.now() - started,
        timeoutMs: TOUR_TARGET_TIMEOUT_MS,
        missingTarget: step.missingTarget,
      });
      if (decision === 'wait') return false;
      cleanup();
      if (decision === 'skip') skip();
      else settle(decision === 'found' ? selector : null);
      return true;
    };

    // Look the target up once the page has settled: fonts loaded (they move
    // everything) and two frames, so a layout that lands after hydration is
    // the one measured. Then watch the page until it appears or time runs out.
    void (async () => {
      try {
        await document.fonts?.ready;
      } catch {
        // A font that fails to load changes nothing about where to point.
      }
      await nextFrame();
      await nextFrame();
      if (cancelled) return;
      started = Date.now();
      if (check(false)) return;
      observer = new MutationObserver(() => {
        if (frame) return;
        frame = requestAnimationFrame(() => {
          frame = 0;
          if (!cancelled) check(false);
        });
      });
      observer.observe(document.body, { childList: true, subtree: true });
      timer = setTimeout(() => {
        if (!cancelled) check(true);
      }, TOUR_TARGET_TIMEOUT_MS);
    })();

    return cleanup;
    // reducedMotion is read, not reacted to: a change mid-step must not re-scroll.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, index, steps, pathname, tick]);

  // Measure and place, and keep doing it while anything moves. The target is
  // looked up again on every measurement because a router refresh replaces the
  // node the step was resolved against. A pending step is a centred card.
  React.useEffect(() => {
    if (!open) return;
    const selector = resolved && resolved.index === index ? resolved.selector : null;
    let frame = 0;

    const measure = () => {
      const vv = window.visualViewport;
      const viewport = {
        width: vv?.width ?? window.innerWidth,
        height: vv?.height ?? window.innerHeight,
      };
      // The tab bar's top edge, measured, so its height and the safe-area
      // inset under it are both counted.
      const bar = reserveBottom ? findVisible(reserveBottom) : null;
      const bottom = bar ? Math.max(0, viewport.height - bar.getBoundingClientRect().top) : 0;
      const reserved = { top: 0, bottom };
      const el = selector ? findVisible(selector) : null;
      const r = el?.getBoundingClientRect();
      // Clamped before it is padded, so the tab bar still reads as inside the bottom band.
      const box = r ? clampRectToViewport({ top: r.top, left: r.left, width: r.width, height: r.height }, viewport, reserved) : null;
      const nextRect = box
        ? {
            top: box.top - SPOTLIGHT_PAD,
            left: box.left - SPOTLIGHT_PAD,
            width: box.width + SPOTLIGHT_PAD * 2,
            height: box.height + SPOTLIGHT_PAD * 2,
          }
        : null;
      const pop = popoverRef.current;
      const size = { width: pop?.offsetWidth ?? POPOVER_FALLBACK_WIDTH, height: pop?.offsetHeight ?? 0 };
      setRect(nextRect);
      setPlacement(placePopover(nextRect, size, viewport, reserved));
    };

    const schedule = () => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        measure();
      });
    };

    measure();
    window.addEventListener('resize', schedule);
    window.addEventListener('scroll', schedule, true);
    window.visualViewport?.addEventListener('resize', schedule);
    window.visualViewport?.addEventListener('scroll', schedule);
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(schedule);
    const target = selector ? findVisible(selector) : null;
    if (observer && target) observer.observe(target);
    if (observer && popoverRef.current) observer.observe(popoverRef.current);

    return () => {
      if (frame) cancelAnimationFrame(frame);
      window.removeEventListener('resize', schedule);
      window.removeEventListener('scroll', schedule, true);
      window.visualViewport?.removeEventListener('resize', schedule);
      window.visualViewport?.removeEventListener('scroll', schedule);
      observer?.disconnect();
    };
  }, [open, index, resolved, reserveBottom]);

  // Focus the heading once per step, so a screen reader reads the new one.
  // Keyed on `ready`: until the card has a placement it is visibility: hidden,
  // and focus() on a hidden element does nothing.
  const current = Math.min(index, Math.max(steps.length - 1, 0));
  const ready = placement !== null;
  React.useEffect(() => {
    if (open && ready) headingRef.current?.focus({ preventScroll: true });
  }, [open, current, ready]);

  // Escape skips; Tab stays inside the card.
  React.useEffect(() => {
    if (!open) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onFinishRef.current('skipped');
        return;
      }
      if (e.key !== 'Tab') return;
      const panel = popoverRef.current;
      const items = Array.from(panel?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? []);
      if (items.length === 0) {
        e.preventDefault();
        return;
      }
      const first = items[0]!;
      const last = items[items.length - 1]!;
      const active = document.activeElement;
      if (e.shiftKey && (active === first || !panel?.contains(active))) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (active === last || !panel?.contains(active))) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [open]);

  if (!open || steps.length === 0) return null;
  const step = steps[current]!;
  const isLast = current === steps.length - 1;
  const spotlight = ready && resolved?.index === current && resolved.selector ? rect : null;
  const motion = reducedMotion ? undefined : 'top .2s ease, left .2s ease, width .2s ease, height .2s ease';

  const goNext = () => {
    if (isLast) {
      onFinishRef.current('done');
      return;
    }
    directionRef.current = 1;
    setIndex(current + 1);
  };
  const goBack = () => {
    backOriginRef.current = current;
    directionRef.current = -1;
    setIndex(Math.max(0, current - 1));
  };

  const progress = labels.progress(current + 1, steps.length);

  return (
    <>
      {/* Catches every click outside the card, so the page behind cannot be
          operated while the tour is up. Dims the screen itself when there is
          no spotlight to do it. */}
      <div
        aria-hidden
        className="fixed inset-0"
        style={{ zIndex: Z_INDEX, background: spotlight ? 'transparent' : SCRIM }}
      />
      {spotlight && (
        <div
          aria-hidden
          className={cn('fixed pointer-events-none rounded-md', classNames?.spotlight)}
          style={{
            zIndex: Z_INDEX,
            top: spotlight.top,
            left: spotlight.left,
            width: spotlight.width,
            height: spotlight.height,
            // The ring is what shows the spotlight on a dark page, where a dimmed
            // near-black and an undimmed near-black look the same. A host sets
            // its colour through --tour-ring; without one it draws nothing.
            boxShadow: `0 0 0 2px var(--tour-ring, transparent), 0 0 0 9999px ${SCRIM}`,
            transition: motion,
          }}
        />
      )}
      <div
        ref={popoverRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={bodyId}
        className={cn(
          'fixed w-[calc(100vw-24px)] max-w-[360px] whitespace-normal break-words text-left md:max-w-[460px]',
          classNames?.popover,
        )}
        style={{
          zIndex: Z_INDEX,
          top: placement?.top ?? 0,
          left: placement?.left ?? 0,
          visibility: ready ? 'visible' : 'hidden',
          transition: motion,
        }}
      >
        <div aria-live="polite" className="sr-only">
          {progress}
        </div>
        <div aria-hidden className="text-[11px] md:text-xs font-semibold uppercase tracking-[0.08em] opacity-70">
          {progress}
        </div>
        <h2 ref={headingRef} id={titleId} tabIndex={-1} className="mt-1 text-lg font-semibold outline-none md:text-2xl">
          {step.title}
        </h2>
        <p id={bodyId} className="mt-2 text-sm leading-relaxed md:text-base">
          {step.body}
        </p>
        <div className="mt-4 flex flex-wrap items-center gap-2 md:mt-6">
          <button
            type="button"
            onClick={() => onFinishRef.current('skipped')}
            className={cn('min-h-[44px] px-3', classNames?.secondary)}
          >
            {labels.skip}
          </button>
          <div className="ml-auto flex items-center gap-2">
            {current > 0 && (
              <button type="button" onClick={goBack} className={cn('min-h-[44px] px-3', classNames?.secondary)}>
                {labels.back}
              </button>
            )}
            <button type="button" onClick={goNext} className={cn('min-h-[44px] px-4', classNames?.primary)}>
              {isLast ? labels.done : labels.next}
            </button>
          </div>
        </div>
      </div>
    </>
  );
}
