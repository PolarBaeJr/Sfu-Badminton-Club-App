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
          // rounded-[var(--r-control,999px)] on all three pieces, the same token
          // Input, Textarea and SearchFilter already take. The admin console
          // defines --r-control: 0, where this was the last pill-shaped control
          // on a screen that is square everywhere else; the player app defines
          // nothing, so the fallback keeps its toggle exactly as it renders
          // today. 999px and not 8px as the fallback, because "unchanged" for a
          // switch is the full pill, not a rounded rectangle.
          'inline-flex items-center justify-center min-w-[44px] min-h-[44px] bg-transparent rounded-[var(--r-control,999px)] focus:outline-none focus:ring-2 focus:ring-[var(--color-accent)] focus:ring-offset-2 focus:ring-offset-[var(--bg-primary)]',
          disabled && 'opacity-50 cursor-not-allowed'
        )}
      >
        <span
          className={cn(
            'relative inline-flex h-6 w-11 items-center rounded-[var(--r-control,999px)] transition-colors',
            checked ? 'bg-[var(--color-accent)]' : 'bg-[var(--border-hover)]'
          )}
        >
          <span
            className={cn(
              'inline-block h-4 w-4 rounded-[var(--r-control,999px)] bg-white transition-transform',
              checked ? 'translate-x-6' : 'translate-x-1'
            )}
          />
        </span>
      </button>
    </div>
  );
}
