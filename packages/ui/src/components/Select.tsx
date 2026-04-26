'use client';

import React from 'react';
import { cn } from '../utils';

interface SelectProps extends React.SelectHTMLAttributes<HTMLSelectElement> {
  label?: string;
  error?: string;
  options: { value: string; label: string }[];
}

export function Select({ label, error, options, className, id, ...props }: SelectProps) {
  const selectId = id || (label ? label.toLowerCase().replace(/\s+/g, '-') : undefined);

  return (
    <div className="space-y-1">
      {label && (
        <label htmlFor={selectId} className="block text-sm font-medium text-[var(--text-secondary)]">
          {label}
        </label>
      )}
      <select
        id={selectId}
        aria-invalid={!!error}
        className={cn(
          'w-full px-3 min-h-[40px] bg-[var(--bg-surface)] border border-[var(--border)] rounded-md text-[var(--text-primary)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-accent)] focus-visible:border-transparent transition-colors disabled:opacity-40 disabled:cursor-not-allowed',
          error && 'border-[var(--color-danger)] focus-visible:ring-[var(--color-danger)]',
          className
        )}
        {...props}
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>{o.label}</option>
        ))}
      </select>
      {error && <p className="text-sm text-[var(--color-danger)]">{error}</p>}
    </div>
  );
}
