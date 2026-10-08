'use client';

import { useLayoutEffect, useRef } from 'react';
import { Textarea } from '@badminton/ui';

/**
 * Sizes a textarea to exactly its content, so the PAGE scrolls and the box
 * never does.
 *
 * `height: auto` first is not redundant: scrollHeight is bounded below by the
 * element's current height, so measuring without resetting can only ever grow
 * the box — delete half a document and it would keep the taller height forever.
 *
 * The border has to be added back. Tailwind's preflight sets
 * `box-sizing: border-box`, so an explicit `height` covers content + padding +
 * border, while scrollHeight covers only content + padding. Assigning
 * scrollHeight alone leaves the box exactly one border short and the textarea
 * scrolls by ~2px — which is the inner scrollbar this component exists to
 * remove. offsetHeight - clientHeight is that border (there is no horizontal
 * scrollbar: the textarea wraps and is `resize-none`).
 */
function fitToContent(el: HTMLTextAreaElement) {
  el.style.height = 'auto';
  el.style.height = `${el.scrollHeight + (el.offsetHeight - el.clientHeight)}px`;
}

/**
 * A Textarea that is always as tall as its content.
 *
 * useLayoutEffect keyed on `value`, rather than the `onInput` handler this
 * replaced, for three reasons:
 *
 *  - it runs on MOUNT, so a long document arrives at full height instead of
 *    opening pre-scrolled (there are four of them on /legal);
 *  - it runs when the value changes for reasons other than typing — saving
 *    clears the local edit and the row re-renders from server state, which
 *    fires no input event and used to leave the box at the old height;
 *  - layout, not passive: it measures and writes before the browser paints, so
 *    there is no frame at the wrong height.
 *
 * Not debounced or rAF'd on purpose. Deferring the resize lets the box lag
 * behind the caret while typing, which is exactly the feel the request was
 * about. One forced reflow per keystroke on a single textarea is cheap, and it
 * is the same cost the previous onInput handler already paid.
 *
 * The inline height survives re-renders: `style` is never passed as a prop
 * here, so React has nothing to reconcile it against and leaves it alone.
 */
export function AutoGrowTextarea({
  value,
  ...props
}: React.TextareaHTMLAttributes<HTMLTextAreaElement> & {
  value: string;
  /** Forwarded to Textarea, which renders the field's <label>. Every other
   *  prop already reached it through the spread; this one was simply missing
   *  from the type, so passing it was a compile error rather than a no-op. */
  label?: string;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);

  useLayoutEffect(() => {
    if (ref.current) fitToContent(ref.current);
  }, [value]);

  // Width changes re-wrap the text, which changes how tall it needs to be
  // without changing `value` — so the effect above never fires. Rotating a
  // phone, or crossing the 980px breakpoint where .settings-row stacks the
  // label above a now full-width control, would otherwise leave the box at its
  // old height and put the inner scrollbar back.
  //
  // Guarded on width because this observes the same element whose HEIGHT
  // fitToContent writes: reacting to every resize would feed our own write
  // back in as a fresh notification and loop.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    let lastWidth = el.clientWidth;
    const observer = new ResizeObserver(() => {
      if (el.clientWidth === lastWidth) return;
      lastWidth = el.clientWidth;
      fitToContent(el);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  return <Textarea ref={ref} value={value} {...props} />;
}
