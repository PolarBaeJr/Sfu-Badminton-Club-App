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
          'relative inline-flex h-6 w-11 items-center rounded-full transition-colors focus:outline-none focus:ring-2 focus:ring-[var(--color-accent)] focus:ring-offset-2 focus:ring-offset-[var(--bg-primary)] min-w-[44px] min-h-[44px] p-[10px]',
          checked ? 'bg-[var(--color-accent)]' : 'bg-[var(--border-hover)]',
          disabled && 'opacity-50 cursor-not-allowed'
        )}
        style={{ padding: '10px' }}
      >
        <span
          className={cn(
            'inline-block h-4 w-4 rounded-full shadow-sm transition-transform',
            checked ? 'bg-white translate-x-5' : 'bg-[var(--text-muted)] translate-x-0'
          )}
        />
      </button>
    </div>
  );
}
