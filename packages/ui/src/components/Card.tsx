'use client';

import React from 'react';
import { cn } from '../utils';

interface CardProps {
  children: React.ReactNode;
  className?: string;
  padding?: boolean;
}

/**
 * `rounded-xl` is a live 16px corner in both apps. The named radius scale was
 * zeroed for a sharp-cornered design until 2026-09-17, when the owner asked for
 * rounded boxes and both tailwind.config.ts files got real values back (md 8px,
 * xl 16px). Pass `rounded-none` only where a corner must stay square on
 * purpose.
 */
export function Card({ children, className, padding = true }: CardProps) {
  return (
    <div className={cn('bg-[var(--bg-card)] border border-[var(--border)] rounded-xl', padding && 'p-6', className)}>
      {children}
    </div>
  );
}
