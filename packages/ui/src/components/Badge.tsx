'use client';

import React from 'react';
import { cn } from '../utils';

interface BadgeProps {
  variant?: 'default' | 'success' | 'warning' | 'danger' | 'info' | 'neutral';
  children: React.ReactNode;
  className?: string;
}

export function Badge({ variant = 'default', children, className }: BadgeProps) {
  // Tailwind v3 silently drops `/opacity` modifiers on var() arbitrary colors
  // (bg-[var(--x)]/20 compiles to nothing), which left these variants as bare
  // text with no pill. color-mix() inside the arbitrary value does the same
  // job and actually compiles.
  const variants = {
    default: 'bg-[color-mix(in_oklab,var(--color-accent)_20%,transparent)] text-[var(--color-accent)]',
    success: 'bg-[color-mix(in_oklab,var(--color-success)_20%,transparent)] text-[var(--color-success)]',
    warning: 'bg-[color-mix(in_oklab,var(--color-warning)_20%,transparent)] text-[var(--color-warning)]',
    danger: 'bg-[color-mix(in_oklab,var(--color-danger)_20%,transparent)] text-[var(--color-danger)]',
    info: 'bg-[rgba(59,130,246,0.12)] text-[var(--color-info)] border border-[rgba(59,130,246,0.3)]',
    neutral: 'bg-[var(--border-hover)] text-[var(--text-muted)]',
  };

  return (
    <span className={cn('inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium', variants[variant], className)}>
      {children}
    </span>
  );
}
