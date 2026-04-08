'use client';

import React from 'react';
import { cn } from '../utils';

interface BadgeProps {
  variant?: 'default' | 'success' | 'warning' | 'danger' | 'info' | 'neutral';
  children: React.ReactNode;
  className?: string;
}

export function Badge({ variant = 'default', children, className }: BadgeProps) {
  const variants = {
    default: 'bg-[var(--color-accent)]/20 text-[var(--color-accent)]',
    success: 'bg-[var(--color-success)]/20 text-[var(--color-success)]',
    warning: 'bg-[var(--color-warning)]/20 text-[var(--color-warning)]',
    danger: 'bg-[var(--color-danger)]/20 text-[var(--color-danger)]',
    info: 'bg-[rgba(59,130,246,0.12)] text-[var(--color-info)] border border-[rgba(59,130,246,0.3)]',
    neutral: 'bg-[var(--border-hover)] text-[var(--text-muted)]',
  };

  return (
    <span className={cn('inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium', variants[variant], className)}>
      {children}
    </span>
  );
}
