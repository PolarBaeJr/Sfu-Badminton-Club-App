'use client';

import React from 'react';
import { cn } from '../utils';

interface BadgeProps {
  variant?: 'default' | 'success' | 'warning' | 'danger' | 'info' | 'neutral';
  children: React.ReactNode;
  className?: string;
}

export function Badge({ variant = 'default', children, className }: BadgeProps) {
  const dotColor = {
    default: 'bg-[var(--ds-accent)]',
    success: 'bg-[var(--color-success)]',
    warning: 'bg-[var(--color-warning)]',
    danger: 'bg-[var(--color-danger)]',
    info: 'bg-[var(--color-info)]',
    neutral: 'bg-[var(--text-muted)]',
  }[variant];

  const textColor = {
    default: 'text-[var(--ds-accent)]',
    success: 'text-[var(--color-success)]',
    warning: 'text-[var(--color-warning)]',
    danger: 'text-[var(--color-danger)]',
    info: 'text-[var(--color-info)]',
    neutral: 'text-[var(--text-muted)]',
  }[variant];

  return (
    <span className={cn('inline-flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide', textColor, className)}>
      <span className={cn('w-1.5 h-1.5 rounded-full', dotColor)} aria-hidden />
      {children}
    </span>
  );
}
