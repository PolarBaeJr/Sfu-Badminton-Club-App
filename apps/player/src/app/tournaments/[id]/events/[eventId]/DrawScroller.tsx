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

export function DrawScroller({
  width, height, children,
}: {
  /** The layout's UNSCALED size. The scale is worked out from it here. */
  width: number;
  height: number;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [avail, setAvail] = useState(0);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    // clientWidth, not getBoundingClientRect: it excludes the box's own
    // scrollbar, so fitting to it cannot leave the chart a scrollbar's width too
    // wide and oscillating between overflowing and not.
    const measure = () => setAvail(el.clientWidth);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // ZERO IS THE PHONE, and it has to mean "leave it alone" rather than "scale to
  // nothing". Below 768px .draw-chart-wrap is display:none, so clientWidth is 0
  // and avail/width would be 0 — a scale of 0 or, on an empty draw, NaN. The
  // same guard covers the first render, before the effect has measured anything.
  const scale = avail > 0 && width > 0
    ? Math.min(1, Math.max(FIT_FLOOR, avail / width))
    : 1;

  const scaledW = Math.ceil(width * scale);
  // COMPUTED, NOT READ BACK OFF THE DOM. scrollWidth is the wrong instrument
  // once a transform is involved: a transform does not change layout size, so
  // the box would still report the full 2088px and the hint would advertise a
  // drag that scaling had already removed. These two numbers are exact, and the
  // +1 absorbs the sub-pixel a fractional pane width leaves behind.
  const overflows = avail > 0 && scaledW > avail + 1;

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
