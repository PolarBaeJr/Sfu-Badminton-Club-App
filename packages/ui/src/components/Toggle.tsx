import * as React from 'react';
import { cn } from '../utils';

export interface ToggleProps {
  on: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
  ariaLabel?: string;
  className?: string;
}

export function Toggle({ on, onChange, disabled, ariaLabel, className }: ToggleProps) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={ariaLabel}
      disabled={disabled}
      onClick={() => !disabled && onChange(!on)}
      className={cn(
        'relative w-[44px] h-[24px] cursor-pointer rounded-none flex-shrink-0 transition-all duration-150 ease-out',
        'disabled:opacity-50 disabled:cursor-not-allowed',
        className,
      )}
      style={{
        background: on ? 'rgba(204,0,0,0.15)' : 'var(--surface2)',
        border: `1px solid ${on ? 'var(--red)' : 'var(--hairline)'}`,
      }}
    >
      <span
        className="absolute top-[2px] w-[18px] h-[18px] block transition-all duration-150 ease-out"
        style={{
          left: on ? '22px' : '2px',
          background: on ? 'var(--red)' : 'var(--muted)',
        }}
      />
    </button>
  );
}
