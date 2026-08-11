'use client';

import React from 'react';
import { cn } from '../utils';

interface CardProps {
  children: React.ReactNode;
  className?: string;
  padding?: boolean;
}

/**
 * `rounded-xl` HERE IS ALREADY ZERO. Do not "fix" it, and do not pass
 * `rounded-none` to flatten it.
 *
 * Both apps replace `theme.borderRadius` outright in their tailwind.config.ts
 * (replace, not extend), so the whole named scale compiles to 0 in each of
 * them — verified in the built CSS, where admin and player alike emit
 * `.rounded-lg,.rounded-md,.rounded-none,.rounded-xl{border-radius:0}`. Only
 * `full` (9999px) and arbitrary values like `rounded-[8px]` survive that.
 *
 * Four separate agents have read this line as a live 12px corner and hand-rolled
 * a `rounded-none` around it or a bordered div instead of it. It has never
 * rendered a corner in either app.
 */
export function Card({ children, className, padding = true }: CardProps) {
  return (
    <div className={cn('bg-[var(--bg-card)] border border-[var(--border)] rounded-xl', padding && 'p-6', className)}>
      {children}
    </div>
  );
}
