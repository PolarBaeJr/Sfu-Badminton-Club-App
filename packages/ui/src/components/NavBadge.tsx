import * as React from 'react';
import { cn } from '../utils';

export interface NavBadgeProps {
  count: number;
  /** Hide when count <= 0. Default true. */
  hideEmpty?: boolean;
  className?: string;
}

export function NavBadge({ count, hideEmpty = true, className }: NavBadgeProps) {
  if (hideEmpty && count <= 0) return null;
  return (
    <span
      className={cn('inline-block text-center leading-none rounded-none', className)}
      style={{
        background: 'var(--red)',
        color: '#fff',
        fontSize: '9px',
        fontWeight: 700,
        padding: '2px 5px',
        minWidth: '16px',
      }}
    >
      {count > 99 ? '99+' : count}
    </span>
  );
}
