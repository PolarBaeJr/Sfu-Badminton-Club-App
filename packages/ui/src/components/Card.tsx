'use client';

import React from 'react';
import { cn } from '../utils';

interface CardProps {
  children: React.ReactNode;
  className?: string;
  padding?: boolean;
  interactive?: boolean;
}

export function Card({ children, className, padding = true, interactive = false }: CardProps) {
  return (
    <div
      className={cn(
        'bg-[var(--bg-card)] border border-[var(--border)] rounded-lg transition-colors duration-150',
        padding && 'p-6',
        interactive && 'hover:border-[color-mix(in_srgb,var(--ds-accent)_30%,transparent)] cursor-pointer',
        className
      )}
    >
      {children}
    </div>
  );
}

export function CardContent({ className, ...props }: React.ComponentPropsWithoutRef<'div'>) {
  return <div className={cn(className)} {...props} />;
}
