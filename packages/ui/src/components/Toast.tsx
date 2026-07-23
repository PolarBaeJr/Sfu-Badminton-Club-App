'use client';

import React from 'react';
import { cn } from '../utils';

interface ToastProps {
  message: string;
  type?: 'success' | 'error' | 'info';
  onClose: () => void;
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
    // .toast is a styling hook for app-level overrides (e.g. the player app
    // lifts toasts above its mobile tabbar in globals.css).
    <div className={cn('toast fixed bottom-4 right-4 z-50 px-4 py-3 rounded-lg shadow-lg flex items-center gap-2', colors[type])}>
      <span>{message}</span>
      <button onClick={onClose} className="ml-2 opacity-70 hover:opacity-100 min-w-[44px] min-h-[44px] flex items-center justify-center">&times;</button>
    </div>
  );
}
