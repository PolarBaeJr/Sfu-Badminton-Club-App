'use client';

import React from 'react';
import { cn } from '../utils';

export function Spinner({ className }: { className?: string }) {
  return (
    <div
      role="status"
      aria-label="Loading"
      className={cn('ds-shimmer-bar relative h-[2px] w-full overflow-hidden bg-[var(--border)]', className)}
    >
      <span aria-hidden className="absolute inset-y-0 w-1/3 bg-[var(--ds-accent)] ds-shimmer-track" />
    </div>
  );
}
