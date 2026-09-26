'use client';

import React from 'react';
import { cn } from '../utils';
import { FOCUSABLE } from './Dialog';
import { placePopover, resolveTarget, type TourPlacement, type TourRect, type TourStep } from '../tour';

// A GUIDED TOUR: a card that walks through a list of steps, each pointing at an
// element on the page with a spotlight cut out of a dimmed screen.
//
// Headless-styled, like NavMenu. Each app passes its own tokens through
// `classNames` and every word through `labels`, so nothing here is copy and
// nothing here knows which app it is in. The decisions (which steps, which
// element, where the card goes) are the pure functions in ../tour.ts.
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
}

const Z_INDEX = 60;
// Breathing room between the spotlight's edge and the element inside it.
const SPOTLIGHT_PAD = 6;
const POPOVER_MAX_WIDTH = 360;
const SCRIM = 'rgba(0, 0, 0, 0.55)';

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

export function Tour({ open, steps, onFinish, labels, classNames, reserveBottom }: TourProps) {
  const [index, setIndex] = React.useState(0);
  // The step whose target has been looked up, and the selector it resolved to
  // (null for a centred card). Until it matches `index` the card stays hidden,
  // so it never flashes at the previous step's position.
  const [resolved, setResolved] = React.useState<{ index: number; selector: string | null } | null>(null);
  const [rect, setRect] = React.useState<TourRect | null>(null);
  const [placement, setPlacement] = React.useState<TourPlacement | null>(null);
  const [reducedMotion, setReducedMotion] = React.useState(false);
  const popoverRef = React.useRef<HTMLDivElement>(null);
  const headingRef = React.useRef<HTMLHeadingElement>(null);
  // Which way the reader is moving, so a step with nothing to point at is
  // skipped in the same direction.
  const directionRef = React.useRef<1 | -1>(1);
  const titleId = React.useId();
  const bodyId = React.useId();

  // Held in a ref for the reason Dialog gives: the caller's handler is a new
  // function on every render, and listing it would re-run the effects below.
  const onFinishRef = React.useRef(onFinish);
  onFinishRef.current = onFinish;

  React.useEffect(() => {
    const query = window.matchMedia('(prefers-reduced-motion: reduce)');
    setReducedMotion(query.matches);
    const onChange = () => setReducedMotion(query.matches);
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, []);

  // Every open starts at the first step, and focus goes back where it came
  // from when the tour closes.
  React.useEffect(() => {
    if (!open) return;
    const previouslyFocused = document.activeElement as HTMLElement | null;
    directionRef.current = 1;
    setIndex(0);
    setResolved(null);
    setPlacement(null);
    return () => {
      previouslyFocused?.focus?.();
    };
  }, [open]);

  // Look the step's target up once the page has settled: fonts loaded (they
  // move everything) and two frames, so a layout that lands after hydration is
  // the one measured.
  React.useEffect(() => {
    if (!open || steps.length === 0) return;
    let cancelled = false;

    const usable = (i: number): { selector: string | null } | null => {
      const step = steps[i]!;
      const selector = resolveTarget(step.targets, isTargetVisible);
      if (selector) return { selector };
      return step.missingTarget === 'center' ? { selector: null } : null;
    };

    void (async () => {
      try {
        await document.fonts?.ready;
      } catch {
        // A font that fails to load changes nothing about where to point.
      }
      await nextFrame();
      await nextFrame();
      if (cancelled) return;

      let i = Math.min(index, steps.length - 1);
      let found: { selector: string | null } | null = null;
      while (i >= 0 && i < steps.length) {
        found = usable(i);
        if (found) break;
        i += directionRef.current;
      }
      // Walked off the front going back: go forward from where we were.
      if (!found && directionRef.current < 0) {
        for (i = index; i < steps.length; i++) {
          found = usable(i);
          if (found) break;
        }
      }
      if (!found) {
        onFinishRef.current('done');
        return;
      }
      if (i !== index) {
        setIndex(i);
        return;
      }
      if (found.selector) {
        findVisible(found.selector)?.scrollIntoView({
          block: 'center',
          // Centring inline as well scrolls the console's horizontal nav strip
          // to the item on a phone.
          inline: 'center',
          behavior: reducedMotion ? 'auto' : 'smooth',
        });
      }
      setResolved({ index: i, selector: found.selector });
    })();

    return () => {
      cancelled = true;
    };
    // reducedMotion is read, not reacted to: a change mid-step must not re-scroll.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, index, steps]);

  // Measure and place, and keep doing it while anything moves. The target is
  // looked up again on every measurement because a router refresh replaces the
  // node the step was resolved against.
  React.useEffect(() => {
    if (!open || !resolved || resolved.index !== index) return;
    const selector = resolved.selector;
    let frame = 0;

    const measure = () => {
      const el = selector ? findVisible(selector) : null;
      const box = el?.getBoundingClientRect();
      const nextRect = box
        ? {
            top: box.top - SPOTLIGHT_PAD,
            left: box.left - SPOTLIGHT_PAD,
            width: box.width + SPOTLIGHT_PAD * 2,
            height: box.height + SPOTLIGHT_PAD * 2,
          }
        : null;
      const vv = window.visualViewport;
      const viewport = {
        width: vv?.width ?? window.innerWidth,
        height: vv?.height ?? window.innerHeight,
      };
      // The tab bar's top edge, measured, so its height and the safe-area
      // inset under it are both counted.
      const bar = reserveBottom ? findVisible(reserveBottom) : null;
      const bottom = bar ? Math.max(0, viewport.height - bar.getBoundingClientRect().top) : 0;
      const pop = popoverRef.current;
      const size = { width: pop?.offsetWidth ?? POPOVER_MAX_WIDTH, height: pop?.offsetHeight ?? 0 };
      setRect(nextRect);
      setPlacement(placePopover(nextRect, size, viewport, { top: 0, bottom }));
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

  // Focus the heading on every step, so a screen reader reads the new one.
  // Keyed on `ready`, not on the step being resolved: until the card has a
  // placement it is visibility: hidden, and focus() on a hidden element does
  // nothing, which on the first step left focus outside the dialog.
  const current = Math.min(index, Math.max(steps.length - 1, 0));
  const ready = resolved !== null && resolved.index === current && placement !== null;
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
  const spotlight = ready && resolved?.selector ? rect : null;
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
            boxShadow: `0 0 0 9999px ${SCRIM}`,
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
        className={cn('fixed whitespace-normal break-words text-left', classNames?.popover)}
        style={{
          zIndex: Z_INDEX,
          width: `min(${POPOVER_MAX_WIDTH}px, calc(100vw - 24px))`,
          top: placement?.top ?? 0,
          left: placement?.left ?? 0,
          visibility: ready ? 'visible' : 'hidden',
          transition: motion,
        }}
      >
        <div aria-live="polite" className="sr-only">
          {progress}
        </div>
        <div aria-hidden className="text-[11px] font-semibold uppercase tracking-[0.08em] opacity-70">
          {progress}
        </div>
        <h2 ref={headingRef} id={titleId} tabIndex={-1} className="mt-1 text-lg font-semibold outline-none">
          {step.title}
        </h2>
        <p id={bodyId} className="mt-2 text-sm leading-relaxed">
          {step.body}
        </p>
        <div className="mt-4 flex flex-wrap items-center gap-2">
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
