'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ArrowLeftRight, ArrowUpDown, ChevronDown, Maximize2, Minimize2, Play, Square } from 'lucide-react';

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

/**
 * THE FULL-SCREEN FLOOR, which is HIGHER than the page's, not lower.
 *
 * "allow full screen too so i can just only show the thing" — the draw goes on
 * a projector at a tournament so the room can watch it fill in. 0.68 was
 * derived for one person at a laptop at arm's length, and that derivation does
 * not survive the change of reader.
 *
 * WHY HIGHER. On a laptop the reader is ~55cm from a screen showing roughly
 * 48px per cm, so the 7.5px partner line at the page floor subtends about 10
 * arcmin. Project the same 1920px onto a 3m-wide screen and it is 6.4px per cm,
 * read from perhaps 8m; matching that same 10 arcmin then takes about 14.5px of
 * rendered type. The line is 11px at FULL size, so a projected chart is already
 * harder to read at 1.0 than a laptop's is at 0.68, and every further step down
 * is spent on a reader at the back who cannot lean in. Shrinking is the wrong
 * currency here.
 *
 * WHY 0.80 AND NOT HIGHER. The floor must never be what stops the largest draw
 * that CAN fit a screen from fitting it. RE-MEASURED in headless Chrome against
 * the compiled CSS, because the figures this note used to carry were 12px
 * optimistic: the pane is the viewport less 36px (18px of shell padding a side)
 * and the budget is the viewport less 82px — 14px of padding top and bottom, a
 * 44px `.draw-topline` and its 10px margin. So 1884×998 at 1920×1080, not the
 * 1010 claimed here before, and a 64-draw (2088×1200) fits both axes at 0.8317
 * rather than 0.842. The conclusion survives with a thinner margin than was
 * advertised: 0.80 still costs nothing at the resolution this feature exists
 * for, but the margin is 0.03 and not 0.04, so a projector whose aspect differs
 * much would lose the whole 64 draw. 8, 16 and 32 fit outright. A 128-draw needs
 * 0.4186 and is refused by this floor — which is what the halves below exist to
 * answer, and until they did it held at 0.80 and scrolled.
 *
 * WHAT IT COSTS, said plainly: on a 1280×720 projector a 32-draw needs 0.73 and
 * so now scrolls where the page floor would have fitted it whole. That is the
 * deliberate trade — 720p is the fading end of the projector market and an
 * illegible whole chart serves the room no better than a legible part of one.
 */
const FULLSCREEN_FLOOR = 0.80;

/**
 * THE FULL-SCREEN CEILING, and it is ABOVE 1.0 — the only place in this app
 * where a diagram is allowed to be drawn larger than it was laid out.
 *
 * `fitScale` in @badminton/shared refuses to magnify, and its reason is sound
 * for the surface it was written for: "a four-player draw blown up to fill a
 * monitor looks broken". A monitor is read from 55cm and the reader can lean
 * in. The argument that raised the floor from the page's 0.68 to 0.80 is the
 * same argument applied to the other end of the range and it comes out the
 * other way: a projected 11px partner line at 1.0 already subtends less than
 * the 10 arcmin a laptop gives it at 0.68, so on a projector every pixel of
 * type is worth having and refusing to magnify is refusing legibility.
 *
 * IT IS WHAT MAKES THE BUSINESS-END VIEW WORTH HAVING AT ALL. That sheet is
 * 936×251px — deliberately small, because being compact is the entire point of
 * it — and capped at 1.0 it would paint a stamp in the corner of a 1884×998
 * projector and leave 87% of the wall blank. That would be a worse answer to
 * "quarter finals to finals" than the void it replaced.
 *
 * WHY 2.0. It is where the FIT binds anyway at the resolution this feature
 * exists for: at 1920×1080 the narrowest sheet the app produces is 936px and
 * the pane is 1884px, so the width alone allows 2.013. The cap therefore costs
 * nothing at 1080p and nothing at all below it — at 1280×720 the same sheet
 * fits at 1.329 and never reaches this number. What it stops is a 4K projector
 * printing four cards at 4x, where the 13px name would be 52px and the sheet
 * would read as a poster rather than as a bracket.
 *
 * THE PAGE IS UNAFFECTED. `fitOf` only consults this when `full` is true, so
 * an 8-entry draw in page flow still opens at 1.0 exactly as before.
 */
const FULLSCREEN_CEILING = 2.0;

/**
 * HOW LONG AN UNATTENDED PROJECTOR HOLDS ONE HALF BEFORE TURNING THE PAGE.
 *
 * Only ever used when the reader has switched rotation on — see the button. 15
 * seconds is the time to find a name in a column of 32 and read the score
 * beside it, not the time to glance at the shape of the draw; the shorter
 * figure would serve the person who already knows where to look and nobody
 * else, and this exists precisely for the room that does not.
 */
const ROTATE_MS = 15000;

/**
 * ONE VIEW OF THE DRAW — the whole sheet, one half of it, or the last three
 * rounds. Every one of them is a SEPARATELY LAID OUT chart, not a crop of a
 * bigger one; see the note at the head of `bracket-layout.ts` for why that
 * distinction is the whole of this feature.
 *
 * Built by the server component, which owns the geometry — this file measures
 * boxes and picks a scale and knows nothing about brackets.
 */
export interface DrawView {
  key: string;
  /** The dropdown's option text: "Whole draw", "Top half", … */
  label: string;
  /**
   * Announced at title size in the full-screen header, for the reader at the
   * back of the hall. Absent on the whole draw, which needs no announcing:
   * a sheet that is the whole draw is not a claim anybody has to check.
   */
  heading?: string;
  /** What the overflow notice calls this sheet: "draw", "half", "quarter", "view". */
  noun: string;
  /**
   * HOW MANY PAGES OF THIS VIEW'S KIND MAKE UP THE WHOLE DRAW: 1 for the whole
   * sheet, 2 for a half, 4 for a quarter. 0 means the view is an EXTRACT and not
   * a cover at all — the business end, which leaves 120 of a 128's matches out
   * on purpose, so no number of copies of it is the draw.
   *
   * IT EXISTS FOR THE ROTATION AND FOR NOTHING ELSE, and the reason is what four
   * quarters did to it. Rotation used to sweep every view that FITS, which was
   * right while the only cover tiers were the whole draw and its halves — but on
   * a 128 at 1080p the halves and the quarters both fit, so the sweep became
   * seven stops and the room waited 105 seconds to see its own half again, half
   * of that spent on the same matches it had just been shown. A cover tier is
   * the unit that makes the sweep a TOUR of the draw rather than a list of
   * sheets, and one tier is all a tour needs.
   *
   * A NUMBER RATHER THAN A NAME, so the rule below can say "the coarsest tier
   * that fits" without knowing that a half is called a half. A view earns its
   * place in the rotation by what it covers and whether it fits, exactly as
   * before; what has changed is that covering the same ground twice no longer
   * counts as two places.
   */
  cover: number;
  /** The sideways-overflow line, which differs by what the sheet meets at. */
  sideHint: string;
  /** This view's UNSCALED size, which is not necessarily the whole draw's. */
  width: number;
  height: number;
  /** How THIS view reads, in the full-screen header. */
  note?: string;
  body: ReactNode;
}

export function DrawScroller({
  title, subtitle, views, heading,
}: {
  /** Shown ONLY in full screen: which event this sheet is. */
  title?: string;
  /** Shown ONLY in full screen, beside the title: the tournament. */
  subtitle?: string;
  /**
   * Shown ONLY on the page (`display:none` in full screen, which has its own
   * header): the card's `Trophy` + `<h2>Draw</h2>` row, authored by the page and
   * handed down here so it can share `.draw-topline` with the Full screen
   * button. The button is what pins this arrangement — it cannot move up to the
   * page, because the fullscreen state is owned here and the control has to stay
   * inside `.draw-chart-wrap` so a phone never sees it.
   */
  heading?: ReactNode;
  /**
   * Every view of this draw, the WHOLE DRAW FIRST. `views[0]` is what the page
   * shows and what full screen falls back to; a draw with only that one entry
   * gets no dropdown at all, which is every draw below 16 entrants.
   */
  views: DrawView[];
}) {
  const ref = useRef<HTMLDivElement>(null);
  const shellRef = useRef<HTMLDivElement>(null);
  // One piece of state for both axes. Measured together in one callback so a
  // resize can never leave the width from this frame and the height from the
  // last one, which would fit the chart to a window that never existed.
  const [box, setBox] = useState({ avail: 0, budget: 0, full: false });

  /**
   * *** THE CHOSEN VIEW IS PURE CLIENT STATE AND IS NEVER SEEDED FROM A
   * MEASUREMENT OR FROM THE PAYLOAD. THAT IS THE WHOLE DESIGN. ***
   *
   * LiveTournament calls router.refresh() every time the desk enters a score,
   * which re-renders this whole subtree from the server and hands `views` a
   * brand new array. If which view is showing were derived from anything that
   * arrives with that render — an index in the payload, a key on the element, a
   * value read back off the DOM — the projected draw would snap back to the top
   * half every time somebody typed a 21, which is several times a minute at a
   * live event. Plain state in a component whose position in the tree does not
   * change survives a refresh untouched, and that is why it is plain state.
   *
   * A KEY AND NOT AN INDEX, which is the one thing that changed when the
   * segmented pager became a dropdown. An index needed a modulo guard for the
   * draw that is REGENERATED under a projector, and even with it an index would
   * quietly land on a different sheet if the regenerated draw had a different
   * set of views — a 128 rebuilt as a 64 keeps its halves but index 3 stops
   * being the same thing. A key cannot be pointed at the wrong view; it can
   * only be absent, and the fallback below handles that.
   *
   * `null` is "nobody has chosen", which defers to the measurement. Once the
   * reader has said otherwise their answer is kept rather than recomputed on
   * the next result.
   */
  const [view, setView] = useState<string | null>(null);
  /** OFF BY DEFAULT, always. See the button. */
  const [rotate, setRotate] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => {
      // Read off the DOCUMENT rather than off React state. This runs from a
      // ResizeObserver and from two listeners, and a state value closed over at
      // mount would be false for the whole life of the effect.
      const full = !!document.fullscreenElement
        && document.fullscreenElement === shellRef.current;
      setBox({
        full,
        // clientWidth, not getBoundingClientRect: it excludes the box's own
        // scrollbar, so fitting to it cannot leave the chart a scrollbar's
        // width too wide and oscillating between overflowing and not.
        avail: el.clientWidth,
        // TWO DIFFERENT BUDGETS, because the box means different things.
        //
        // In the page its height is whatever the scale last made it, so
        // measuring it would fit the chart to the height the chart already had
        // and never converge — the budget has to come from the window, less the
        // sticky topbar.
        //
        // In full screen the shell is a flex column and this box is
        // `flex: 1 1 auto; min-height: 0`, so its height is dictated by the
        // SCREEN — what is left under the header — and not by its content.
        // There it can be measured directly, which also means the header's real
        // height is accounted for rather than guessed at.
        budget: full
          ? el.clientHeight
          : Math.max(0, window.innerHeight - TOPBAR_H - BOTTOM_GUTTER),
      });
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    // BOTH, and the listener is not redundant. Shorten the window without
    // changing its width and this box's content box does not change at all —
    // its width comes from the pane and its height from the middle box, which
    // is still sized from the previous scale — so the observer never fires and
    // a height-only resize would never re-fit.
    window.addEventListener('resize', measure);
    // AND fullscreenchange, which is not covered by either of the other two.
    // Entering full screen on a screen the same size as the window changes no
    // box at all, so the observer may never fire, and the browser does not
    // reliably raise `resize` for it — but the BUDGET has changed, because the
    // topbar is gone. This is also the only path that runs when Esc is pressed.
    document.addEventListener('fullscreenchange', measure);
    return () => {
      ro.disconnect();
      window.removeEventListener('resize', measure);
      document.removeEventListener('fullscreenchange', measure);
    };
  }, []);

  const { avail, budget, full } = box;

  /**
   * NOTHING IS SET OPTIMISTICALLY HERE. `full` is only ever written by the
   * `fullscreenchange` handler above, so a request the browser refuses — which
   * it will if it does not judge this a user gesture, or if the page is in an
   * iframe without `allow="fullscreen"` — leaves the component exactly as it
   * was rather than styled for a full screen it never got.
   */
  const toggleFull = () => {
    const el = shellRef.current;
    if (!el) return;
    if (document.fullscreenElement) {
      void document.exitFullscreen?.().catch(() => {});
      return;
    }
    // UNPREFIXED ONLY, on purpose. A webkit fallback here would be half a
    // fallback and worse than none: the measuring below reads
    // `document.fullscreenElement`, the listener is `fullscreenchange` and the
    // stylesheet keys off `:fullscreen`, so an element that went full screen
    // through a prefixed call would be full screen with the page's flex layout,
    // the page's floor, no header, and a button still offering to enter. Safari
    // has shipped the unprefixed element method since 16.4; below that the
    // button simply does nothing and the chart stays where it was.
    void el.requestFullscreen?.().catch(() => {});
  };

  // ZERO IS THE PHONE, and it has to mean "leave it alone" rather than "scale to
  // nothing". Below 768px .draw-chart-wrap is display:none, so clientWidth is 0
  // and avail/width would be 0 — a scale of 0 or, on an empty draw, NaN. The
  // same guard covers the first render, before the effect has measured anything.
  //
  // THE SMALLER OF THE TWO FITS. Taking the width alone is what left a 64-draw
  // 1200px tall on a screen with 800px to give it. `null` is the unmeasured
  // case, kept distinct from a real fit so that the floor is applied to a
  // number that was actually measured and never to a placeholder.
  const fitOf = (w: number, h: number) =>
    avail > 0 && budget > 0 && w > 0 && h > 0
      ? Math.min(full ? FULLSCREEN_CEILING : 1, Math.min(avail / w, budget / h))
      : null;
  const floor = full ? FULLSCREEN_FLOOR : FIT_FLOOR;

  /**
   * WHICH VIEW IS ON SCREEN, in three steps: what the reader chose, else what
   * the measurement chooses, else the whole draw.
   *
   * WHEN THE MEASUREMENT CHOOSES SOMETHING OTHER THAN THE WHOLE DRAW: only when
   * the whole draw cannot be shown whole. "what if u split 128 into 2 and 64
   * aswell, 2 pages?" — but a draw that FITS has nothing to gain from being cut
   * up, and a reader who opens a 32 and finds half of it has been surprised for
   * no reason. So the test is the floor and nothing else: if the whole sheet
   * needs less than 0.80 it cannot be shown at a size the back of the room can
   * read, and only then is part of it the better answer. A 128 crosses that
   * line at every resolution; a 64 crosses it at 720p and not at 1080p; a 32
   * crosses it at 720p only.
   *
   * MEASURED AGAINST THE UNFLOORED FIT, not against the scale actually used.
   * The scale has already been clamped up to 0.80, so comparing IT to the floor
   * would compare a number to itself and never be true.
   *
   * THE FALLBACK IS THE FIRST VIEW THAT FITS, not "the top half" by name. The
   * halves are the cheapest thing to fall back to on a big draw and they come
   * first in the list, so on a 128 that is still the top half — but a draw that
   * is offered only the business end (a 16, which has no halves) falls back to
   * that instead of to nothing, and nothing here has to know the names.
   */
  const whole = views[0]!;
  const wholeFit = fitOf(whole.width, whole.height);
  const canSwitch = full && views.length > 1;
  const autoKey =
    canSwitch && wholeFit !== null && wholeFit < FULLSCREEN_FLOOR
      ? (views.slice(1).find((v) => {
          const f = fitOf(v.width, v.height);
          return f !== null && f >= FULLSCREEN_FLOOR;
        }) ?? views[1]!).key
      : whole.key;

  /**
   * THE GUARD FOR A DRAW REGENERATED UNDER A PROJECTOR. The exec rebuilds the
   * bracket, the server sends a different set of views, and the key the reader
   * chose may no longer be one of them. Falling back to the measurement's own
   * answer is what the reader would have got had they never chosen, which is
   * the least surprising thing a sheet can do with nobody at the keyboard.
   */
  const activeKey = canSwitch && view !== null && views.some((v) => v.key === view)
    ? view
    : (canSwitch ? autoKey : whole.key);
  const active = views.find((v) => v.key === activeKey) ?? whole;
  const activeIndex = views.indexOf(active);

  // Everything below is about THE SHEET ON SCREEN, which is one view and not
  // necessarily the whole thing. One pair of numbers so no measurement can be
  // taken against the wrong sheet.
  const sheetW = active.width;
  const sheetH = active.height;
  const fit = fitOf(sheetW, sheetH);
  const scale = fit === null ? 1 : Math.max(floor, fit);

  const scaledW = Math.ceil(sheetW * scale);
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
  const overflows = avail > 0 && scaledW > avail + 1;

  /**
   * DOWNWARD OVERFLOW IS ONLY WORTH SAYING IN FULL SCREEN, and the reason is
   * the same one that justifies the sideways hint rather than an exception to
   * it: what makes an overflow worth captioning is whether it is discoverable.
   *
   * In the page a floored draw simply makes a tall block and the PAGE scrolls,
   * which is the most discoverable gesture on the web — captioning it would
   * tell the reader something they already know. In full screen there is no
   * page behind this to scroll, so the shell gives the box its own vertical
   * scroller, and that is the undiscoverable case all over again: a draw can
   * run a whole screen below the fold with nothing on the sheet admitting it.
   * That is at its worst here, because a projected chart may have nobody at the
   * keyboard — so the notice is what tells whoever set it up that the room is
   * seeing a cropped draw.
   */
  const scaledH = Math.ceil(sheetH * scale);
  const overflowsDown = full && budget > 0 && scaledH > budget + 1;

  /**
   * CHANGING THE VIEW PUTS THE READER BACK AT THE TOP LEFT OF IT.
   *
   * Only matters when the new sheet does not fit either — at 720p a 128 half
   * still needs 0.54 — but there it matters completely: the scroll box is one
   * element that survives the swap, so without this the second half would open
   * at wherever the first half had been dragged to, which on a projector is a
   * chart nobody can put back.
   */
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.scrollLeft = 0;
    el.scrollTop = 0;
  }, [activeKey]);

  /**
   * WHAT ROTATION SWEEPS: ONE COVER TIER, plus whatever extracts fit.
   *
   * An unattended wall chart that spends fifteen seconds in three on a cropped
   * 128 whole draw is showing the room a corner of a bracket, which is the exact
   * failure paging exists to end — so the floor that picks the default view
   * filters this too. But fitting is not sufficient on its own, which is what
   * four quarters proved: a 128 at 1080p fits both halves AND all four quarters,
   * and sweeping all of them is a 105-second cycle that shows the top half's
   * matches twice. So the sweep is the COARSEST cover tier every page of which
   * fits — see `cover` on DrawView — and it is a tour of the draw in the fewest
   * pages the screen can carry.
   *
   * THE EXTRACT RIDES ALONG. "Quarter-finals to final" is not a page of any
   * cover, and it is what a room at 7pm on finals night is actually there for, so
   * it joins any tier that fits beside it. That keeps a 128 at 1080p on exactly
   * the three stops it swept before this change.
   *
   * WHEN NOTHING FITS, THE FINEST TIER, not the coarsest. On a 128 at 720p every
   * tier crops: the whole draw at 0.2676, the halves at 0.5317, the quarters at
   * 0.7300 — measured, and the quarters are the only one of the three that is
   * within a tenth of the floor.
   * The old rule fell back to the unfiltered list and put the 0.27 sheet — a
   * corner of a bracket — on the wall for fifteen seconds in five. The finest
   * tier is the least-cropped thing there is, so that is what a screen too small
   * for any of them gets.
   *
   * The fallback to the unfiltered list survives for the sweep of ONE, which is
   * a button that turns itself on and then appears broken.
   */
  const fits = (v: DrawView) => {
    const f = fitOf(v.width, v.height);
    return f !== null && f >= FULLSCREEN_FLOOR;
  };
  const tiers = Array.from(new Set(views.filter((v) => v.cover > 0).map((v) => v.cover)))
    .sort((a, b) => a - b);
  // EVERY page of a tier, not any: a tour that skips a quarter is not a tour.
  const tier = tiers.find((t) => views.every((v) => v.cover !== t || fits(v)))
    ?? tiers[tiers.length - 1]
    ?? 1;
  const touring = views.filter((v) => v.cover === tier || (v.cover === 0 && fits(v)));
  const sweep = touring.length > 1 ? touring : views;
  const sweepAt = sweep.findIndex((v) => v.key === activeKey);
  const nextKey = sweep.length ? sweep[(sweepAt + 1) % sweep.length]!.key : activeKey;

  /**
   * ARROW KEYS, because a tournament desk has a keyboard and the room does not.
   *
   * Bound only while there is more than one view to move between, so nothing is
   * intercepted on the page or on a draw that has no choice to make.
   * preventDefault is deliberate: the scroll box owns the arrow keys too, and a
   * chart that fits — which is the point of this whole feature — has nothing for
   * them to scroll, so changing the view is the only useful thing they could be
   * doing.
   *
   * *** IT STANDS DOWN FOR THE DROPDOWN. *** A native <select> owns the arrow
   * keys when it has focus — that is how a listbox is operated, open or closed,
   * and it is the behaviour a keyboard reader expects. Stealing them would make
   * the one control that exists to choose a view the one place a view cannot be
   * chosen. So the handler ignores any key event aimed at a form control and
   * lets the browser have it; everywhere else on the sheet the arrows still turn
   * the page, which is what the desk actually uses.
   *
   * ARROWS STEP THE FULL LIST, not the rotation's filtered sweep: somebody is at
   * the keyboard, and a reader who presses right expects the next thing on the
   * menu even if it is a sheet that will scroll.
   */
  useEffect(() => {
    if (!canSwitch) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === 'SELECT' || tag === 'INPUT' || tag === 'TEXTAREA') return;
      const step = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
      if (!step) return;
      e.preventDefault();
      setView(views[((activeIndex + step) % views.length + views.length) % views.length]!.key);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
    // `views` is a fresh array every render, so the LENGTH and the INDEX are
    // what this depends on — the two primitives that decide where a step lands.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canSwitch, activeIndex, views.length]);

  /**
   * THE UNATTENDED PROJECTOR, and it is OFF until somebody asks for it.
   *
   * A hall puts the draw on a wall and walks away, and a sheet that never turns
   * shows the room half the tournament — so this is genuinely useful. It is
   * also genuinely infuriating if you are reading, which is why it can never be
   * the default and why the button says out loud that it is running.
   *
   * *** THE DEPS ARE PRIMITIVES ONLY. *** `views` is a fresh array on every
   * render, and this component re-renders every time the desk enters a score
   * (LiveTournament coalesces at 700ms). An array in this list would tear the
   * interval down and start it again on each of those, and the view would never
   * actually turn.
   *
   * `nextKey` IS IN THE DEPS ON PURPOSE, and it is a string. It changes exactly
   * once per turn — including a turn the reader made by hand — so the countdown
   * is restarted by the same events that restart the bar below, which is keyed
   * on the view for the same reason. Before, the bar reset and the timer did
   * not, so a manual change left the room watching a countdown that was already
   * half spent.
   */
  useEffect(() => {
    if (!rotate || !canSwitch) return;
    const t = setInterval(() => setView(nextKey), ROTATE_MS);
    return () => clearInterval(t);
  }, [rotate, canSwitch, nextKey]);

  return (
    // THE SHELL IS WHAT GOES FULL SCREEN, not the scroll box, so the header
    // below travels with the chart. It lives inside .draw-chart-wrap, which is
    // display:none under 768px — so a phone never sees the button at all and
    // needs no separate rule. That is the right answer rather than an
    // oversight: full screen exists to project a wall chart at a tournament,
    // and the phone deliberately does not render the wall chart. A phone-sized
    // full screen of a 2472px sheet would be the sideways drag this whole
    // change removed, and the round-by-round list stays what a phone gets.
    <div ref={shellRef} className="draw-shell">
      {/* ONE ROW, NOT A CAPTION AND A FLOATING CLUSTER. In full screen the
          header and the controls are laid out side by side here, so the
          controls take the room they need and the title gets what is left.
          They used to be absolutely positioned over the header with a
          `padding-right: 160px` reserved for them, which was a number that
          could only ever be right for the exact set of buttons it was measured
          against — and this change adds four more. ON THE PAGE IT IS A FLEX ROW
          TOO, now that the card's own heading shares it with the Full screen
          button: "in the same row as draw". It used to be a plain block whose
          only visible child was the right-aligned .draw-tools, which put that one
          button on a line of its own under the heading and the reading note. */}
      <div className="draw-topline">
        {/* THE PAGE'S HEADER, and the reason this row is a flex row off full
            screen at all. It is the exact counterpart of .draw-full-head below:
            each is display:none in the other's mode, so the two never paint
            together and neither had to be compromised into serving both. On the
            page the row is [ Draw ................ Full screen ]; in full screen
            it is [ Men's Singles · SFU Open · how to read it ... controls ]. */}
        {heading && <div className="draw-page-head">{heading}</div>}
        {/* Seen only in full screen (display:none otherwise). A projected sheet
            with no caption is a bracket nobody in the room can place; on the
            page this would only repeat the header a few centimetres above. */}
        <div className="draw-full-head">
          {title && <span className="draw-full-title">{title}</span>}
          {/* WHAT THE ROOM IS LOOKING AT, and it is set in the header rather
              than left to the small print in the controls, because the question
              it answers — "is my match on this sheet?" — is asked from the back
              of the hall by somebody who cannot read the dropdown. It is the
              draw's own words: the reading note and every card's label already
              say top half and bottom half.

              THE WHOLE DRAW CARRIES NO HEADING, which is why this reads off
              `heading` and not off `label`. A sheet that is the entire draw is
              not a claim the room has to check, and announcing it would put a
              red-barred caption on the one view that never needed one. */}
          {active.heading && <span className="draw-page-label">{active.heading}</span>}
          {subtitle && <span className="draw-full-sub">{subtitle}</span>}
          {/* HOW TO READ IT, repeated here because the page's copy of this line
              is a sibling ABOVE the shell and so is outside the element that goes
              full screen — it would simply never paint. A converging draw is not
              how anybody expects a bracket to read until they are told once, and
              a room watching a projection is the audience least likely to have
              been told. On a half page it is that page's own line: what it meets
              at is a semi-final, and the final is on both pages. */}
          {active.note && <span className="draw-full-note">{active.note}</span>}
        </div>

        <div className="draw-tools">
          {canSwitch && (
            <div className="draw-pager">
              {/* ONE DROPDOWN, NOT A ROW OF BUTTONS. "just setup a dropdown" —
                  "for all the section since one cannot be active when other is
                  active". The views ARE one mutually exclusive choice, and a
                  single-select control is the only shape that says so; a row of
                  toggles says "any number of these may be on" and then has to
                  take it back with aria-pressed. It also stops the row growing
                  a button per view, which four views and a rotation toggle had
                  already made crowded on a 720p header.

                  A NATIVE <select>, NOT @badminton/ui's `Select`. That
                  component is a form FIELD — a 48px full-width control with an
                  optional block label above it, on `--bg-surface` — and every
                  one of its callers is an admin dialog; the player app has
                  never used it. Dropped into this row it would need its width,
                  its wrapper, its padding, its radius, its type ramp and its
                  label all overridden, which is everything it contributes
                  except the <option> loop. So the markup is written here and
                  the look comes from .draw-view-select, next to the buttons it
                  sits beside.

                  THE VALUE IS `activeKey`, WHICH IS NOT ALWAYS WHAT THE READER
                  PICKED. Before anybody chooses, the measurement chooses — and
                  a dropdown reading "Whole draw" over a projected top half
                  would be the control lying about the screen. It shows what is
                  on the wall. */}
              <span className="draw-view-pick">
                <label className="sr-only" htmlFor="draw-view-select">
                  Which part of the draw to show
                </label>
                <select
                  id="draw-view-select"
                  className="draw-view-select"
                  value={activeKey}
                  onChange={(e) => setView(e.target.value)}
                >
                  {views.map((v) => (
                    <option key={v.key} value={v.key}>{v.label}</option>
                  ))}
                </select>
                {/* Drawn rather than left to the OS, because `appearance: none`
                    is what lets this control carry the mono caption voice the
                    two buttons beside it use. pointer-events:none so the whole
                    box is still the select's own target. */}
                <ChevronDown size={14} className="draw-view-chev" aria-hidden="true" />
              </span>
              {/* ROTATION SAYS SO WHEN IT IS ON. An unattended wall chart wants
                  it and a reader does not, so it starts off, and when it is
                  running the button carries the interval and a bar under the
                  header counts it down — a view that turns under somebody
                  mid-sentence should never be a mystery.

                  STILL A BUTTON, and it is not a view. It is an action that
                  runs WHILE a view is shown, so it is not one of the things the
                  dropdown is choosing between and putting it in there would be
                  claiming it is. */}
              <button
                type="button"
                className="draw-page-btn"
                aria-pressed={rotate}
                onClick={() => setRotate((r) => !r)}
              >
                {rotate
                  ? <Square size={10} aria-hidden="true" />
                  : <Play size={10} aria-hidden="true" />}
                {rotate ? `Auto ${ROTATE_MS / 1000}s` : 'Auto'}
              </button>
            </div>
          )}
          <button
            type="button"
            className="draw-full-btn"
            onClick={toggleFull}
            aria-pressed={full}
          >
            {full ? <Minimize2 size={12} aria-hidden="true" /> : <Maximize2 size={12} aria-hidden="true" />}
            {full ? 'Exit full screen' : 'Full screen'}
          </button>
        </div>
      </div>

      {/* HOW THE CHART READS, on the page. It used to be printed by Draw as a
          sibling ABOVE this shell; it had to come inside so that the heading and
          the Full screen button could take the row above it, and it reads off
          the ACTIVE VIEW rather than off a prop so there is still exactly one
          copy of the string in the codebase.

          Off full screen `active` is ALWAYS `views[0]` — `canSwitch` is
          `full && views.length > 1`, so the dropdown cannot have moved it — which
          is what makes this the whole draw's reading note and not some half's.
          In full screen the same text is inside .draw-full-head instead, so this
          copy is display:none there and the note is never printed twice. */}
      {active.note && <p className="draw-page-note">{active.note}</p>}

      {/* The countdown. Keyed on the view so the CSS animation restarts from
          zero on every turn, including the ones the reader made by hand — which
          is now also when the interval itself restarts. See the effect. */}
      {rotate && canSwitch && (
        <div className="draw-rotate-bar" aria-hidden="true">
          <span key={activeKey} style={{ animationDuration: `${ROTATE_MS}ms` }} />
        </div>
      )}

      {(overflows || overflowsDown) && (
        <p className="draw-hint">
          {overflowsDown && !overflows
            ? <ArrowUpDown size={12} aria-hidden="true" />
            : <ArrowLeftRight size={12} aria-hidden="true" />}
          {/* "This draw" is the wrong noun once the sheet is one HALF of it:
              the notice exists to tell whoever set the projector up that the
              room is seeing a crop, and it would be saying so about the wrong
              thing. Switching views is meant to end the crop, not to
              renegotiate it. The noun and the sideways line both come off the
              view, so a view added later cannot be described as a half. */}
          {overflows && overflowsDown
            ? `This ${active.noun} is bigger than the screen — scroll to see all of it`
            : overflowsDown
              ? `This ${active.noun} is taller than the screen — scroll down for the rest`
              : active.sideHint}
        </p>
      )}
      {/* tabIndex makes a SCROLLABLE region reachable by keyboard, which a
          scroll box with no focusable child otherwise is not — so it is gated
          on the box actually scrolling — on EITHER axis, since in full screen
          this box owns the vertical scroll too. A chart that fits has nothing
          to scroll and a tab stop there is a stop that does nothing, which
          since this box started fitting is the common case. The region and its
          label stay either way, so it is still reachable by landmark
          navigation.

          The fade below stays width-only: it is a horizontal mask and it says
          "there is more to the SIDE", which vertical overflow does not make
          true. */}
      <div
        ref={ref}
        tabIndex={overflows || overflowsDown ? 0 : -1}
        role="region"
        // WHICH VIEW, HERE TOO. The arrow keys are the one control with no
        // visible press to feel, so without this a keyboard reader changes the
        // view and is told nothing at all about where they landed.
        aria-label={active.heading
          ? `Tournament draw, ${active.heading.toLowerCase()}`
          : 'Tournament draw'}
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
        <div style={{ width: scaledW, height: scaledH }}>
          <div
            className="relative"
            style={{
              width: sheetW,
              height: sheetH,
              transform: `scale(${scale})`,
              transformOrigin: 'top left',
            }}
          >
            {/* ONLY THE SHEET ON SCREEN IS MOUNTED. Keeping every view in the
                DOM behind a `display: none` would leave a 128-entrant chart —
                127 cards and some 700 connector spans — laid out and repainted
                on every live refresh for nobody to see, four times over. The
                views arrive as markup from the server either way, so mounting
                one is a swap and not a fetch. */}
            {active.body}
          </div>
        </div>
      </div>
    </div>
  );
}
