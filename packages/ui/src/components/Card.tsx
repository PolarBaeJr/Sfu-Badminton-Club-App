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
        'transition-colors duration-150 rounded-none',
        padding && 'p-6',
        interactive && 'cursor-pointer hover:border-[var(--hairline-strong)]',
        className,
      )}
      style={{
        background: 'var(--surface1)',
        border: '1px solid var(--hairline)',
        borderRadius: 0,
        boxShadow: 'none',
      }}
    >
      {children}
    </div>
  );
}

export function CardContent({ className, ...props }: React.ComponentPropsWithoutRef<'div'>) {
  return <div className={cn(className)} {...props} />;
}
