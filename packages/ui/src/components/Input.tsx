'use client';

import React from 'react';
import { cn } from '../utils';

interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {
  label?: string;
  error?: string;
}

export const Input = React.forwardRef<HTMLInputElement, InputProps>(
  ({ label, error, className, id, ...props }, ref) => {
    const inputId = id || (label ? label.toLowerCase().replace(/\s+/g, '-') : undefined);

    return (
      <div className="space-y-1">
        {label && (
          <label htmlFor={inputId} className="block text-sm font-medium text-[var(--text-secondary)]">
            {label}
          </label>
        )}
        <input
          ref={ref}
          id={inputId}
          className={cn(
            'w-full px-3 min-h-[48px] bg-[var(--bg-surface)] border border-[var(--border)] rounded-lg text-[var(--text-primary)] placeholder-[var(--text-muted)] focus:outline-none focus:ring-2 focus:ring-[var(--color-accent)] focus:border-transparent transition-colors disabled:opacity-50 disabled:cursor-not-allowed',
            error && 'border-[var(--color-danger)] focus:ring-[var(--color-danger)]',
            className
          )}
          {...props}
        />
        {error && <p className="text-sm text-[var(--color-danger)]">{error}</p>}
      </div>
    );
  }
);
Input.displayName = 'Input';
