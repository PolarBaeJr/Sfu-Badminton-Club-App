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
const FOCUSABLE =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function Dialog({ open, onClose, title, children }: DialogProps) {
  const panelRef = useRef<HTMLDivElement>(null);

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
    (focusables()[0] ?? panelRef.current)?.focus();

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
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
  }, [open, onClose]);

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
        className="relative bg-[var(--bg-elevated)] border border-[var(--border)] rounded-[16px] p-6 max-w-lg w-full mx-4 max-h-[90vh] overflow-y-auto whitespace-normal break-words"
      >
        <div className="flex items-center justify-between mb-4">
          <h2 id="dialog-title" className="text-lg font-semibold text-[var(--text-primary)]">{title}</h2>
          <button
            onClick={onClose}
            aria-label="Close dialog"
            className="text-[var(--text-muted)] hover:text-[var(--text-primary)] min-w-[44px] min-h-[44px] flex items-center justify-center rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]"
          >
            &times;
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}
