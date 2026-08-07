'use client';

import React from 'react';
import { cn } from '../utils';

interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {
  label?: string;
  error?: string;
}

// `<input type="number">` accepts "e", "E" and "+" because they are valid in
// scientific notation — so a match score of "e" is typed happily, reaches
// state as the string "e", and the field reads as filled while carrying
// nothing numeric. (Worse: `valueAsNumber` is NaN and `e.target.value` on a
// number input returns "" for some invalid states, so the bad value can vanish
// rather than fail loudly.) No field in this app is scientific notation.
//
// "-" and "." are deliberately still allowed: fee amounts take decimals, and a
// future signed field would need the minus. Only the exponent forms go.
const EXPONENT_KEYS = ['e', 'E', '+'];

export const Input = React.forwardRef<HTMLInputElement, InputProps>(
  ({ label, error, className, id, onKeyDown, onPaste, ...props }, ref) => {
    const inputId = id || (label ? label.toLowerCase().replace(/\s+/g, '-') : undefined);
    const errorId = inputId ? `${inputId}-error` : undefined;
    const isNumeric = props.type === 'number';

    const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (isNumeric && EXPONENT_KEYS.includes(e.key)) e.preventDefault();
      onKeyDown?.(e);
    };

    // Typing is not the only way in — a paste bypasses onKeyDown entirely.
    const handlePaste = (e: React.ClipboardEvent<HTMLInputElement>) => {
      if (isNumeric) {
        const pasted = e.clipboardData.getData('text');
        if (EXPONENT_KEYS.some((k) => pasted.includes(k))) e.preventDefault();
      }
      onPaste?.(e);
    };

    return (
      <div className="space-y-1">
        {label && (
          <label htmlFor={inputId} className="block text-[13px] font-medium text-[var(--text-secondary)] mb-1.5">
            {label}
            {props.required && <span className="text-[var(--color-accent)]"> *</span>}
          </label>
        )}
        <input
          ref={ref}
          id={inputId}
          aria-invalid={!!error}
          aria-describedby={error && errorId ? errorId : undefined}
          onKeyDown={handleKeyDown}
          onPaste={handlePaste}
          // Numeric keypad on phones, where the roster is actually used.
          inputMode={isNumeric ? 'decimal' : props.inputMode}
          className={cn(
            'w-full px-3 min-h-[48px] bg-[var(--bg-surface)] border border-[var(--border)] rounded-[8px] text-[var(--text-primary)] placeholder-[var(--text-muted)] focus:outline-none focus:ring-2 focus:ring-[var(--color-accent)] focus:border-transparent transition-colors disabled:opacity-50 disabled:cursor-not-allowed',
            error && 'border-[var(--color-danger)] focus:ring-[var(--color-danger)]',
            className
          )}
          {...props}
        />
        {error && <p id={errorId} className="text-sm text-[var(--color-danger)]">{error}</p>}
      </div>
    );
  }
);
Input.displayName = 'Input';
