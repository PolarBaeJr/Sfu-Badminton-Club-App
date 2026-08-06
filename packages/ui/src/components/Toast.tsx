'use client';

import React from 'react';
import { createPortal } from 'react-dom';
import { cn } from '../utils';

/**
 * Where toasts sit in the app's stacking order.
 *
 * Every overlay in this codebase sets its own z-index and there was no agreed
 * order, so the toast's old `z-50` was not "the top" — it was the middle of an
 * undocumented ladder:
 *
 *     40   sticky topbar (globals.css .topbar), mobile tabbar (.mobile-tabbar)
 *     50   Dialog / ConfirmDialog, WaiverGate, DeletionGate
 *     60   PlayerPicker menu, DatePicker calendar
 *     100  Dropdown menu, OfflineBanner
 *
 * A toast at 50 therefore rendered *under* any open Dropdown, PlayerPicker or
 * DatePicker, and tied with Dialog — where the winner was decided by DOM order
 * alone, i.e. by wherever ToastProvider happened to sit in the tree rather
 * than by any decision. It also was not portalled, so it inherited whatever
 * stacking context its ancestors created.
 *
 * Both halves are fixed here: the viewport is portalled to document.body (so
 * no ancestor can trap it) and sits deliberately above everything in the list
 * above. A toast is the app answering something you just did; if anything is
 * allowed to cover it, the answer is lost.
 */
export const TOAST_Z_INDEX = 200;

interface ToastProps {
  message: string;
  type?: 'success' | 'error' | 'info';
  onClose: () => void;
}

/**
 * The fixed, portalled container every toast lives in. Rendered once by the
 * app's ToastProvider around its list of <Toast>s.
 *
 * Stacking toasts in a flex column also fixes the second way they hid each
 * other: they used to be individually `fixed` at the same corner, so two at
 * once landed exactly on top of one another.
 *
 * The bottom offset comes from `--toast-offset` (default 16px) rather than a
 * class, so an app can lift toasts clear of its own chrome — the player app's
 * mobile tabbar — by setting one custom property. Deliberately not a Tailwind
 * utility: an inline `bottom` would out-specify the app's override, and a
 * class would depend on that utility surviving content scanning.
 */
export function ToastViewport({ children }: { children: React.ReactNode }) {
  // document.body only exists after mount; rendering the portal during SSR
  // would throw.
  const [mounted, setMounted] = React.useState(false);
  React.useEffect(() => setMounted(true), []);
  if (!mounted) return null;

  return createPortal(
    <div
      className="toast-viewport"
      role="status"
      aria-live="polite"
      style={{
        position: 'fixed',
        bottom: 'var(--toast-offset, 16px)',
        right: 16,
        zIndex: TOAST_Z_INDEX,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'flex-end',
        gap: 8,
        // The container spans nothing visually; only the slabs inside it
        // should intercept clicks.
        pointerEvents: 'none',
      }}
    >
      {children}
    </div>,
    document.body,
  );
}

export function Toast({ message, type = 'info', onClose }: ToastProps) {
  // Per-variant text color: success/error sit on solid color (white text);
  // info sits on the theme surface, which is light in light mode — white text
  // was invisible there. The close button inherits currentColor via opacity.
  // On the black/red editorial system a saturated green slab reads foreign,
  // so success is a dark toast with a green hairline + a green left accent bar
  // (keeps the "success" cue without the candy fill). Error stays solid red —
  // red is the brand accent, so a red slab is on-brand.
  const colors = {
    success: 'bg-[var(--bg-elevated)] text-[var(--text-primary)] border border-[var(--border)] border-l-2 border-l-[var(--color-success)]',
    error: 'bg-[var(--color-danger)] text-white',
    info: 'bg-[var(--bg-elevated)] text-[var(--text-primary)] border border-[var(--border)]',
  };

  React.useEffect(() => {
    const timer = setTimeout(onClose, 4000);
    return () => clearTimeout(timer);
  }, [onClose]);

  return (
    // Positioning belongs to ToastViewport — a toast that positions itself is
    // how two of them ended up in the same corner. `.toast` stays as a styling
    // hook for app-level overrides.
    <div
      className={cn('toast px-4 py-3 rounded-lg shadow-lg flex items-center gap-2', colors[type])}
      style={{ pointerEvents: 'auto' }}
    >
      <span>{message}</span>
      <button onClick={onClose} className="ml-2 opacity-70 hover:opacity-100 min-w-[44px] min-h-[44px] flex items-center justify-center">&times;</button>
    </div>
  );
}
