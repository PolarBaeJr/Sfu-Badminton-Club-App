'use client';

import React, { useEffect } from 'react';

interface DialogProps {
  open: boolean;
  onClose: () => void;
  title: string;
  children: React.ReactNode;
}

export function Dialog({ open, onClose, title, children }: DialogProps) {
  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="fixed inset-0 bg-black/60" onClick={onClose} />
      <div
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
