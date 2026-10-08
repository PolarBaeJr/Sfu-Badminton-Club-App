'use client';

import React from 'react';
import { cn } from '../utils';

interface TextareaProps extends React.TextareaHTMLAttributes<HTMLTextAreaElement> {
  label?: string;
  error?: string;
}

export const Textarea = React.forwardRef<HTMLTextAreaElement, TextareaProps>(
  ({ label, error, className, id, ...props }, ref) => {
    const textareaId = id || (label ? label.toLowerCase().replace(/\s+/g, '-') : undefined);

    return (
      <div className="space-y-1">
        {label && (
          <label htmlFor={textareaId} className="block text-[13px] font-medium text-[var(--text-secondary)] mb-1.5">
            {label}
            {props.required && <span className="text-[var(--color-accent)]"> *</span>}
          </label>
        )}
        <textarea
          ref={ref}
          id={textareaId}
          className={cn(
            // rounded-[var(--r-control,8px)] — see the note in Input.tsx. The
            // console defines --r-control: 0; the player app leaves it unset
            // and keeps the 8px fallback.
            'w-full px-3 py-3 bg-[var(--bg-surface)] border border-[var(--border)] rounded-[var(--r-control,8px)] text-[var(--text-primary)] placeholder-[var(--text-muted)] focus:outline-none focus:ring-2 focus:ring-[var(--color-accent)] focus:border-transparent resize-none transition-colors disabled:opacity-50 disabled:cursor-not-allowed',
            error && 'border-[var(--color-danger)]',
            className
          )}
          rows={3}
          {...props}
        />
        {error && <p className="text-sm text-[var(--color-danger)]">{error}</p>}
      </div>
    );
  }
);
Textarea.displayName = 'Textarea';
