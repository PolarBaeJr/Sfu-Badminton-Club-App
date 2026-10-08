'use client';

import React from 'react';
import { createPortal } from 'react-dom';
import { AlertTriangle, CheckCircle2, Info } from 'lucide-react';
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
 *     210  StaleBuildBanner (STALE_BUILD_Z_INDEX)
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
 *
 * The one thing above a toast is StaleBuildBanner, and only because it is the
 * exit from a tab where no answer is coming at all.
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
  // All three variants are now the same shape: the theme surface, a hairline,
  // and a 2px accent bar in the variant's colour.
  //
  // Error used to be a solid red slab with white text. That was defensible when
  // every error was three words ("Failed", "Not authorized"), but the messages
  // this app raises are sentences — "This match changed while you were entering
  // the result — most likely another desk got there first. Reload and check
  // before entering it again." A paragraph of white-on-saturated-red is hard to
  // read, and at that length the slab stops looking like a notification and
  // starts looking like a wall.
  //
  // The red is still there, in the bar, the icon and the hairline. Nothing is
  // lost: the accent bar is what the eye catches, and success already proved
  // the pattern reads correctly on this black/red system.
  const variants = {
    success: {
      accent: 'var(--color-success)',
      Icon: CheckCircle2,
      label: 'Success',
    },
    error: {
      accent: 'var(--color-danger)',
      Icon: AlertTriangle,
      label: 'Error',
    },
    info: {
      accent: 'var(--border-hover)',
      Icon: Info,
      label: 'Note',
    },
  } as const;

  const { accent, Icon, label } = variants[type];

  // Held in a ref rather than listed as a dependency. The provider renders
  // onClose={() => remove(t.id)} — a new arrow every render — so with [onClose]
  // in the array this effect re-ran whenever ANY toast was added or removed,
  // clearing the pending timer and starting a fresh 4 seconds. A run of toasts
  // kept resetting each other's clocks, so they lingered instead of dismissing.
  const onCloseRef = React.useRef(onClose);
  onCloseRef.current = onClose;

  React.useEffect(() => {
    const timer = setTimeout(() => onCloseRef.current(), 4000);
    return () => clearTimeout(timer);
    // Empty: one 4-second life per mounted toast, started once.
  }, []);

  return (
    // Positioning belongs to ToastViewport — a toast that positions itself is
    // how two of them ended up in the same corner. `.toast` stays as a styling
    // hook for app-level overrides.
    <div
      className={cn(
        'toast flex items-start gap-3 rounded-lg py-3 pl-3 pr-2 shadow-lg',
        'bg-[var(--bg-elevated)] text-[var(--text-primary)] border border-[var(--border)]',
      )}
      style={{
        pointerEvents: 'auto',
        borderLeft: `2px solid ${accent}`,
        // A sentence needs a column, not a strip. Without a cap, a long message
        // stretched the toast most of the way across a desktop window and set
        // the text in one unreadable line; without the floor it collapsed to the
        // width of the close button on a phone.
        maxWidth: 'min(92vw, 26rem)',
      }}
    >
      <Icon
        className="w-4 h-4 shrink-0 mt-0.5"
        style={{ color: accent }}
        aria-hidden="true"
      />
      {/* The variant, for anyone who cannot see the colour. aria-live on the
          viewport announces the message; without this the reading of an error
          and a success are identical. */}
      <span className="sr-only">{label}: </span>
      {/* min-w-0 lets the text actually wrap inside the flex row instead of
          forcing the container wider than its own max-width. */}
      <span className="min-w-0 flex-1 text-sm leading-snug break-words">{message}</span>
      <button
        onClick={onClose}
        aria-label="Dismiss"
        // The 44px touch target is kept, but as a negative-margin hit area so it
        // stops inflating the slab: at py-3 the old button made every toast
        // ~68px tall regardless of how little it said.
        className="shrink-0 -my-3 -mr-2 w-11 h-11 flex items-center justify-center rounded-md text-[var(--text-muted)] hover:text-[var(--text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--color-accent)]"
      >
        &times;
      </button>
    </div>
  );
}
