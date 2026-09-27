'use client';

import React from 'react';
import { cn } from '../utils';

interface SwitchProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label?: string;
  description?: string;
  disabled?: boolean;
  className?: string;
}

export function Switch({ checked, onChange, label, description, disabled, className }: SwitchProps) {
  return (
    <div className={cn('flex items-center justify-between min-h-[48px]', className)}>
      {(label || description) && (
        <div className="flex-1 mr-3">
          {label && <p className="text-sm text-[var(--text-primary)]">{label}</p>}
          {description && <p className="text-xs text-[var(--text-muted)]">{description}</p>}
        </div>
      )}
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={label}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={cn(
          // The track and knob are always a full pill, in both apps: a switch
          // with 8px corners reads as a rounded rectangle, not a toggle. Only
          // this focus-ring wrapper follows --r-control, the token Input,
          // Textarea and SearchFilter take, so its ring matches their corners.
          'inline-flex items-center justify-center min-w-[44px] min-h-[44px] bg-transparent rounded-[var(--r-control,999px)] focus:outline-none focus:ring-2 focus:ring-[var(--color-accent)] focus:ring-offset-2 focus:ring-offset-[var(--bg-primary)]',
          disabled && 'opacity-50 cursor-not-allowed'
        )}
      >
        <span
          className={cn(
            'relative inline-flex h-6 w-11 items-center rounded-full transition-colors',
            checked ? 'bg-[var(--color-accent)]' : 'bg-[var(--border-hover)]'
          )}
        >
          <span
            className={cn(
              'inline-block h-4 w-4 rounded-full bg-white transition-transform',
              checked ? 'translate-x-6' : 'translate-x-1'
            )}
          />
        </span>
      </button>
    </div>
  );
}
