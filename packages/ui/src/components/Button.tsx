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
  const base = 'inline-flex items-center justify-center font-medium rounded-lg transition-colors focus:outline-none focus:ring-2 focus:ring-[var(--color-accent)] focus:ring-offset-2 focus:ring-offset-[var(--bg-primary)] disabled:opacity-50 disabled:cursor-not-allowed';
  const variants = {
    primary: 'bg-[var(--color-accent)] text-white hover:bg-[var(--color-accent-hover)]',
    secondary: 'bg-[var(--bg-surface)] text-[var(--text-primary)] hover:brightness-110',
    danger: 'bg-[var(--color-danger)] text-white hover:brightness-110',
    ghost: 'bg-transparent text-[var(--text-secondary)] hover:bg-[var(--border-hover)]',
    success: 'bg-[var(--color-success)] text-white hover:brightness-110',
  };
  const sizes = {
    sm: 'px-3 min-h-[36px] text-sm',
    md: 'px-4 min-h-[44px] text-sm',
    lg: 'px-6 min-h-[48px] text-base',
  };

  return (
    <button
      className={cn(base, variants[variant], sizes[size], className)}
      disabled={disabled || loading}
      {...props}
    >
      {loading && (
        <svg className="animate-spin -ml-1 mr-2 h-4 w-4" viewBox="0 0 24 24">
          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" />
          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
        </svg>
      )}
      {children}
    </button>
  );
}
