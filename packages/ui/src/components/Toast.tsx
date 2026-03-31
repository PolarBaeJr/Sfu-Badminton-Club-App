'use client';

import React from 'react';
import { cn } from '../utils';

interface ToastProps {
  message: string;
  type?: 'success' | 'error' | 'info';
  onClose: () => void;
}

export function Toast({ message, type = 'info', onClose }: ToastProps) {
  const colors = {
    success: 'bg-[var(--color-success)]',
    error: 'bg-[var(--color-danger)]',
    info: 'bg-[var(--bg-surface)]',
  };

  React.useEffect(() => {
    const timer = setTimeout(onClose, 4000);
    return () => clearTimeout(timer);
  }, [onClose]);

  return (
    <div className={cn('fixed bottom-4 right-4 z-50 px-4 py-3 rounded-lg text-white shadow-lg flex items-center gap-2', colors[type])}>
      <span>{message}</span>
      <button onClick={onClose} className="ml-2 text-white/70 hover:text-white min-w-[44px] min-h-[44px] flex items-center justify-center">&times;</button>
    </div>
  );
}
