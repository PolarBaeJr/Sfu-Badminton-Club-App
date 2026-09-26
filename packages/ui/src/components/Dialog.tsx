'use client';

import React, { useEffect, useRef } from 'react';

interface DialogProps {
  open: boolean;
  onClose: () => void;
  title: string;
  children: React.ReactNode;
}

// Anything the browser will stop on with Tab. :not([disabled]) matters because a
// disabled submit button is common in these dialogs while a form is saving.
// :not([tabindex="-1"]) on every selector because an element with tabindex -1 is
// not in the Tab order, so it must not be a trap end or the initial-focus target.
// Select relies on this: its desktop form mirror and its hidden touch-mode
// trigger both carry tabindex -1.
export const FOCUSABLE =
  'a[href]:not([tabindex="-1"]), button:not([disabled]):not([tabindex="-1"]), textarea:not([disabled]):not([tabindex="-1"]), input:not([disabled]):not([tabindex="-1"]), select:not([disabled]):not([tabindex="-1"]), [tabindex]:not([tabindex="-1"])';

export function Dialog({ open, onClose, title, children }: DialogProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  // The children container, so initial focus can skip the header's close button.
  const bodyRef = useRef<HTMLDivElement>(null);

  // onClose is almost always an inline arrow at the call site, so it is a NEW
  // function on every render. Held in a ref instead of listed as a dependency:
  // with it in the array, the effect below re-ran on every keystroke — because
  // typing sets state, which re-renders, which makes a new onClose — and each
  // re-run moved focus back to the first field. Typing a year yanked the caret
  // to the Term dropdown once per character.
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!open) return;

    // Send focus back where it came from on close. Without this, dismissing a
    // dialog opened from a roster row drops focus to the top of the document and
    // a keyboard user has to tab back through the whole table.
    const previouslyFocused = document.activeElement as HTMLElement | null;

    // Move focus into the panel so the trap below has something to cycle, and so
    // a screen reader announces the dialog rather than continuing to read the
    // page behind it.
    const focusables = () =>
      Array.from(panelRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? []);

    // Skip the close button. It is first in the DOM, so focusing focusables()[0]
    // put a visible focus ring on the × the instant any dialog opened — which
    // looks like a rendering fault at the panel corner, and lands the user on
    // "dismiss" when they opened a form to fill it in. Prefer the first control
    // in the BODY; fall back to the close button, then the panel itself, so a
    // dialog with no fields still traps focus.
    const inBody = () =>
      Array.from(bodyRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? []);
    (inBody()[0] ?? focusables()[0] ?? panelRef.current)?.focus();

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onCloseRef.current();
        return;
      }
      if (e.key !== 'Tab') return;

      // Without this, Tab walks straight out of the panel and into the page
      // behind it — the dialog is only visually modal, so a keyboard or screen
      // reader user ends up operating controls they cannot see.
      const items = focusables();
      if (items.length === 0) {
        e.preventDefault();
        return;
      }
      const first = items[0]!;
      const last = items[items.length - 1]!;
      const active = document.activeElement;
      // Focus may sit on the panel itself (no focusable children yet) or have
      // escaped already; either way, put it back on the appropriate end.
      if (e.shiftKey && (active === first || !panelRef.current?.contains(active))) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (active === last || !panelRef.current?.contains(active))) {
        e.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      previouslyFocused?.focus?.();
    };
    // `open` alone: this is open/close behaviour, not per-render behaviour.
  }, [open]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="fixed inset-0 bg-black/60" onClick={onClose} />
      <div
        ref={panelRef}
        // Focusable so the panel can hold focus when it has no focusable
        // children yet; -1 keeps it out of the normal Tab order.
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-labelledby="dialog-title"
        // whitespace-normal is load-bearing, not tidying. A dialog is rendered
        // where it is triggered — the roster's Unban/Remove dialogs live inside
        // an actions <td> that sets whitespace-nowrap to keep its buttons on one
        // line. position: fixed takes the panel out of that cell's LAYOUT but
        // white-space is inherited, so the prose refused to wrap and every
        // sentence was clipped at the panel's right edge. break-words covers the
        // same class of problem for a long unbroken string (an email, a URL).
        //
        // text-left IS THE THIRD MEMBER OF THAT FAMILY, and it was missing.
        // The announcements table opens its edit dialog from an actions cell
        // that sets text-right, and text-align inherits through position: fixed
        // exactly as white-space does, so every plain block label in the panel
        // sat against the right edge. Labels inside a flex row were unaffected,
        // because flex placement ignores text-align, and that split is what made
        // it read as a quirk of certain fields rather than one inherited
        // property. Set here rather than on the cell: a dialog can be triggered
        // from any aligned container, and the panel is the one place that knows
        // it is no longer in that container's layout.
        className="relative bg-[var(--bg-elevated)] border border-[var(--border)] rounded-[16px] p-6 max-w-lg w-full mx-4 max-h-[90vh] overflow-y-auto whitespace-normal break-words text-left"
      >
        <div className="flex items-center justify-between mb-4">
          <h2 id="dialog-title" className="text-lg font-semibold text-[var(--text-primary)]">{title}</h2>
          <button
            onClick={onClose}
            aria-label="Close dialog"
            // ring-inset: the panel scrolls (overflow-y-auto), so an outset ring
            // on a control flush against the corner is drawn outside the panel's
            // rounded border and reads as a rendering fault. Inset keeps it on
            // the button.
            className="text-[var(--text-muted)] hover:text-[var(--text-primary)] min-w-[44px] min-h-[44px] flex items-center justify-center rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--color-accent)]"
          >
            &times;
          </button>
        </div>
        {/* Wrapper exists so initial focus can target the first control in the
            BODY rather than the close button above it. */}
        <div ref={bodyRef}>{children}</div>
      </div>
    </div>
  );
}
