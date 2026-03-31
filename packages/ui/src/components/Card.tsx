'use client';

import React from 'react';
import { cn } from '../utils';

interface CardProps {
  children: React.ReactNode;
  className?: string;
  padding?: boolean;
}

export function Card({ children, className, padding = true }: CardProps) {
  return (
    <div className={cn('bg-[var(--bg-card)] border border-[var(--border)] rounded-xl', padding && 'p-6', className)}>
      {children}
    </div>
  );
}
