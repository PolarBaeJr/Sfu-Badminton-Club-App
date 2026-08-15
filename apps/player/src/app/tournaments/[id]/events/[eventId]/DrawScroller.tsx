'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ArrowLeftRight } from 'lucide-react';

/**
 * The horizontal scroll box the draw chart lives in, and the one line that says
 * it moves.
 *
 * MEASURED, NOT DERIVED FROM A BREAKPOINT. The calendar's `.cal-hint` is shown
 * by a media query, which it can be because its grid has one fixed floor
 * (620px) and one page gutter, so the width at which it stops overflowing is a
 * number somebody could work out once. A draw does not have one width: a
 * four-entry chart is 552px and a 64-entry one is 2088px, and the honest
 * breakpoint is four rounds' worth of different. So the box asks itself whether
 * it actually overflows. That is also stricter than the calendar's rule — the
 * hint cannot outlive the overflow it describes at ANY width, not just at the
 * one that was derived.
 *
 * The overflow is contained HERE, on the inner box, and the chart is
 * `display: none` on a phone anyway (see DrawRounds). The page body never
 * scrolls sideways.
 */
export function DrawScroller({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [overflows, setOverflows] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    // The +1 absorbs the sub-pixel difference a fractional layout width leaves
    // behind, which would otherwise advertise a one-pixel drag.
    const measure = () => setOverflows(el.scrollWidth > el.clientWidth + 1);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  return (
    <>
      {overflows && (
        <p className="draw-hint">
          <ArrowLeftRight size={12} aria-hidden="true" />
          Scroll sideways — the two halves meet at the final
        </p>
      )}
      {/* tabIndex makes a scrollable region reachable by keyboard, which a
          scroll box with no focusable child otherwise is not. */}
      <div
        ref={ref}
        tabIndex={0}
        role="region"
        aria-label="Tournament draw"
        className="draw-scroll scroll-fade-x"
      >
        {children}
      </div>
    </>
  );
}
