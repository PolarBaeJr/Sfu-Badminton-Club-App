'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ArrowLeftRight } from 'lucide-react';

/**
 * THE DRAW SHRINKS TO FIT ITS BOX, and only scrolls when shrinking any further
 * would stop it being readable.
 *
 * "why did u make it so i have to scroll for the events tho on the play it
 * should just be a smaller one with smaller text boxes?" — a converging chart is
 * 1704px at 32 entrants and the pane on a laptop is nearer 1350px, so the
 * default was a sideways drag on the commonest draw in the club. It now opens
 * scaled down instead.
 *
 * WIDTH ONLY, NOT BOTH AXES, and that is the one place this deliberately
 * departs from the console. The console caps itself at 78vh and grows an inner
 * scrollbar, so a diagram that overflows downwards there costs the reader a
 * second scroll surface, and its `fitScale` fits the whole sheet. This chart is
 * in page flow with no cap: it is as tall as it likes and the page scrolls, the
 * way every other block on the page does. Fitting the height too would shrink a
 * 64-draw to 0.5 to solve a problem this layout does not have. So the shared
 * `fitScale` is NOT used here — its height term is wrong for a chart that has
 * no height budget — and the arithmetic below is the width half of it.
 *
 * A TRANSFORM, NOT SMALLER GEOMETRY. Every truncation figure in Draw.tsx is
 * quoted against COL_W = 168: the 130.0px name field, "Katarzyna Kowalski"
 * fitting on a chart card, the 231.9px joined doubles label that does not, the
 * 123.3px longest partner name that does. A CSS transform scales the type with
 * the card and moves none of those thresholds — a 231.9px string in a 130px
 * field truncates at exactly the same character at 75% as at 100%. Re-deriving
 * the geometry from a scale factor would invalidate every one of those measured
 * numbers and buy nothing. It is also what makes "smaller text boxes" true for
 * free: there is no separate type ramp to keep in step.
 */

/**
 * THE FLOOR: below this the chart scrolls instead of shrinking further.
 *
 * The console's floor is 0.5 and that number does NOT transfer, because it is
 * not a legibility figure — it is a tap target. Its whole card is a button, its
 * card is 88px, and 88 × 0.5 = 44px exactly. Nothing on this chart is
 * pressable, so the binding constraint here is a different kind: can the name
 * be read. Copying 0.5 would be copying a number whose derivation does not
 * apply, and it would put the partner line at 5.5px.
 *
 * Derived from the 11px doubles partner line, which is the smallest type on
 * this card that a reader actually has to READ — it is a person's name, and a
 * card whose names cannot be made out says nothing at all. The 13px singles
 * name is load-bearing too but it is not the smallest, so it is not what binds.
 *
 * 0.68 IS A MEASURED NUMBER, not a round one. Rendered at 1:1 against the
 * compiled CSS with the real Barlow files: at 0.612 (a 128-draw fitted whole to
 * a 1512px pane) the partner line is 6.7px and the names are a grey blur —
 * "Bartholomew Al-Rashid" and "Siobhan O'Callaghan" cannot be told apart. At
 * 0.68 the same line is 7.5px and both read cleanly. The break is between those
 * two, and the floor is set at the side of it that was checked rather than
 * interpolated.
 *
 * The 10px seed gutter and footer strip fall to 6.8px, below what this would
 * allow if they were what set the number. They are not, on purpose: a seed and
 * a "21-19" are glanced at, not read. Flooring on those would force 0.8, and at
 * 0.8 a 32-draw — the size the complaint was actually about — would still
 * scroll on every laptop narrower than 1490px.
 *
 * WHAT IT BUYS, measured. A pane is the viewport less 88px (28px of page
 * padding a side, 16px of chart padding a side). On a 1440px laptop (1352px
 * pane) draws of 8, 16 and 32 now open whole with no sideways scroll at all,
 * where a 32 was a 352px drag. The floor is deliberately just under the 0.700
 * that a 32-draw needs on a 1280px laptop, so the commonest draw in the club
 * fits unscrolled on the narrowest common screen. A 64 and a 128 still scroll,
 * which is the right answer: fitting a 128 whole would take 0.48.
 */
const FIT_FLOOR = 0.68;

/**
 * THE HEIGHT BUDGET: how much of the window the chart has to fit inside.
 *
 * "this still doesnt fit in a paghe". Fitting the width alone was not what was
 * asked for. A 64-draw is 1200px tall and a 128 is 2384px, so a chart that had
 * stopped dragging sideways still ran three screens off the bottom, and the
 * thing the reader wants from a wall chart — the shape of the draw, at a glance
 * — needs BOTH axes on screen at once. "Vertical scrolling is free" was the
 * wrong assumption and this is where it is dropped.
 *
 * WHAT "FITS" MEANS HERE, precisely, because it is not "visible without ever
 * scrolling". The event page has a header, the entrants and the check-in state
 * above the draw, so the chart is never on screen at page load whatever its
 * size. It fits when, once the reader has scrolled its top up under the sticky
 * topbar, the whole chart is inside the window.
 *
 * So the budget is the window less the chrome that is still on screen at that
 * point, and the only such chrome is `.topbar` — it is `position: sticky` and
 * everything else in the shell scrolls away with the page. (`OfflineBanner` is
 * `position: fixed`, but it exists only while the connection is down and
 * budgeting for it permanently would shrink every chart for a state that is
 * almost never true.)
 *
 * 71px IS MEASURED, and the arithmetic that looks like it derives it is wrong.
 * globals.css says next to `.notif-section` that the sticky topbar is "14px + a
 * 34px mark + 14px + a hairline ≈ 63px"; the box actually reports 71px at every
 * width above 980, because the brand mark is not what sets the row's height.
 * That comment was written for another surface and taking it on trust would
 * have handed the chart 8px it does not have. Below 980px `.topbar-inner` drops
 * to 12px of padding and the bar measures 63px, so 71 is the larger of the two
 * values the chart can meet and therefore the safe one to budget for.
 *
 * NO max-height, AND THAT IS THE DEPARTURE FROM THE CONSOLE. The console caps
 * its diagram at 78vh and lets it scroll inside its own box. That is right for
 * a pane in a full-height console shell and wrong here: this chart sits in a
 * page that already scrolls, and a nested vertical scroll region inside a
 * scrolling page traps the wheel and gives the reader two ways to move one
 * axis. The budget picks the SCALE and nothing else. When the floor stops a
 * draw fitting, the block is simply tall and the page scrolls, exactly as a
 * long block should.
 */
const TOPBAR_H = 71;
/** So the last row of cards is not flush against the bottom of the window. */
const BOTTOM_GUTTER = 24;

export function DrawScroller({
  width, height, children,
}: {
  /** The layout's UNSCALED size. The scale is worked out from it here. */
  width: number;
  height: number;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  // One piece of state for both axes. Measured together in one callback so a
  // resize can never leave the width from this frame and the height from the
  // last one, which would fit the chart to a window that never existed.
  const [box, setBox] = useState({ avail: 0, budget: 0 });

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () =>
      setBox({
        // clientWidth, not getBoundingClientRect: it excludes the box's own
        // scrollbar, so fitting to it cannot leave the chart a scrollbar's
        // width too wide and oscillating between overflowing and not.
        avail: el.clientWidth,
        // The WINDOW, not this box. The box's own height is whatever the scale
        // last made it, so measuring that would fit the chart to the height the
        // chart already had and never converge.
        budget: Math.max(0, window.innerHeight - TOPBAR_H - BOTTOM_GUTTER),
      });
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    // BOTH, and the listener is not redundant. Shorten the window without
    // changing its width and this box's content box does not change at all —
    // its width comes from the pane and its height from the middle box, which
    // is still sized from the previous scale — so the observer never fires and
    // a height-only resize would never re-fit.
    window.addEventListener('resize', measure);
    return () => {
      ro.disconnect();
      window.removeEventListener('resize', measure);
    };
  }, []);

  const { avail, budget } = box;

  // ZERO IS THE PHONE, and it has to mean "leave it alone" rather than "scale to
  // nothing". Below 768px .draw-chart-wrap is display:none, so clientWidth is 0
  // and avail/width would be 0 — a scale of 0 or, on an empty draw, NaN. The
  // same guard covers the first render, before the effect has measured anything.
  //
  // THE SMALLER OF THE TWO FITS, then floored. Taking the width alone is what
  // left a 64-draw 1200px tall on a screen with 800px to give it.
  const scale = avail > 0 && budget > 0 && width > 0 && height > 0
    ? Math.min(1, Math.max(FIT_FLOOR, Math.min(avail / width, budget / height)))
    : 1;

  const scaledW = Math.ceil(width * scale);
  // COMPUTED, NOT READ BACK OFF THE DOM. scrollWidth is the wrong instrument
  // once a transform is involved: a transform does not change layout size, so
  // the box would still report the full 2088px and the hint would advertise a
  // drag that scaling had already removed. These two numbers are exact, and the
  // +1 absorbs the sub-pixel a fractional pane width leaves behind.
  //
  // STILL WIDTH ALONE, now that the scale fits both axes, and it stays exact:
  // if the height binds then the scale is below the width's own fit and the
  // width has room to spare, if the width binds it fits exactly, and only at
  // the floor can either overflow. So this cannot claim a drag that is not
  // there.
  //
  // There is deliberately NO matching notice when a floored draw runs off the
  // bottom. The hint exists because sideways scrolling inside a box is
  // undiscoverable — nothing about the page suggests that box moves. Scrolling
  // the page down is the most discoverable gesture there is, and captioning it
  // would be telling the reader something they already know.
  const overflows = avail > 0 && scaledW > avail + 1;

  return (
    <>
      {overflows && (
        <p className="draw-hint">
          <ArrowLeftRight size={12} aria-hidden="true" />
          Scroll sideways — the two halves meet at the final
        </p>
      )}
      {/* tabIndex makes a SCROLLABLE region reachable by keyboard, which a
          scroll box with no focusable child otherwise is not — so it is gated
          on the box actually scrolling, for the same reason the fade below is.
          A chart that fits has nothing to scroll and a tab stop there is a stop
          that does nothing, which since this box started fitting is the common
          case. The region and its label stay either way, so it is still
          reachable by landmark navigation. */}
      <div
        ref={ref}
        tabIndex={overflows ? 0 : -1}
        role="region"
        aria-label="Tournament draw"
        // The edge fade says "there is more this way", so it is now gated on
        // there being more. Applied unconditionally it dimmed the first and last
        // column of a chart that fitted whole — which, since this box started
        // scaling to fit, is the common case rather than the rare one.
        className={`draw-scroll${overflows ? ' scroll-fade-x' : ''}`}
      >
        {/* TWO NESTED BOXES, because a CSS transform does not change layout
            size. Scaled on its own, the chart would still RESERVE its full
            1704px and the scroll box would never shrink its scrollbar — the
            reader would be dragging across empty space to the right of a
            chart that already fitted. The middle box is sized to the SCALED
            result and only the inner one is transformed. */}
        <div style={{ width: scaledW, height: Math.ceil(height * scale) }}>
          <div
            className="relative"
            style={{
              width,
              height,
              transform: `scale(${scale})`,
              transformOrigin: 'top left',
            }}
          >
            {children}
          </div>
        </div>
      </div>
    </>
  );
}
