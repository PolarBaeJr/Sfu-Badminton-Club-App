'use client';

import React from 'react';
import { cn } from '../utils';

interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'secondary' | 'danger' | 'ghost' | 'success';
  size?: 'sm' | 'md' | 'lg';
  loading?: boolean;
}

export function Button({
  variant = 'primary',
  size = 'md',
  loading,
  className,
  children,
  disabled,
  ...props
}: ButtonProps) {
  const base = 'inline-flex items-center justify-center font-medium rounded-md transition-[background-color,transform,opacity] duration-150 active:scale-[0.98] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-accent)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--bg-primary)] disabled:opacity-40 disabled:cursor-not-allowed disabled:active:scale-100';
  const variants = {
    primary: 'bg-[var(--ds-accent)] text-[#0A0A0A] hover:brightness-110',
    secondary: 'bg-[var(--bg-surface)] text-[var(--text-primary)] border border-[var(--border)] hover:border-[var(--ds-accent)]',
    danger: 'bg-[var(--color-danger)] text-white hover:brightness-110',
    ghost: 'bg-transparent text-[var(--text-secondary)] hover:text-[var(--ds-accent)] hover:bg-[var(--ds-accent-dim)]',
    success: 'bg-[var(--color-success)] text-[#0A0A0A] hover:brightness-110',
  };
  const sizes = {
    sm: 'px-3 min-h-[32px] text-sm',
    md: 'px-4 min-h-[40px] text-sm',
    lg: 'px-6 min-h-[48px] text-base',
  };

  return (
    <button
      className={cn(base, variants[variant], sizes[size], 'relative', className)}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...props}
    >
      <span className={cn('inline-flex items-center', loading && 'invisible')}>{children}</span>
      {loading && (
        <span aria-live="polite" className="absolute inset-0 inline-flex items-center justify-center gap-1">
          <span className="w-1 h-1 rounded-full bg-current animate-pulse" style={{ animationDelay: '0ms' }} />
          <span className="w-1 h-1 rounded-full bg-current animate-pulse" style={{ animationDelay: '150ms' }} />
          <span className="w-1 h-1 rounded-full bg-current animate-pulse" style={{ animationDelay: '300ms' }} />
        </span>
      )}
    </button>
  );
}
