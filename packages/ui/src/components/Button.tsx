'use client';

import React from 'react';
import { cn } from '../utils';

export type ButtonVariant =
  | 'red' | 'ghost' | 'dark' | 'danger'
  | 'primary' | 'secondary' | 'success' | 'outline';

interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: 'sm' | 'md' | 'lg';
  loading?: boolean;
}

const aliasV3: Record<ButtonVariant, 'red' | 'ghost' | 'dark' | 'danger'> = {
  red: 'red',
  ghost: 'ghost',
  dark: 'dark',
  danger: 'danger',
  primary: 'red',
  secondary: 'ghost',
  success: 'red',
  outline: 'dark',
};

const variantStyle: Record<'red' | 'ghost' | 'dark' | 'danger', string> = {
  red:    'bg-[var(--red)] text-white hover:bg-[var(--red-dark)] disabled:bg-[var(--surface2)] disabled:text-[var(--ghost)]',
  ghost:  'bg-transparent text-[var(--text)] border border-[var(--hairline)] hover:border-[var(--hairline-strong)] hover:text-[var(--ink)] disabled:text-[var(--ghost)]',
  dark:   'bg-[var(--surface2)] text-[var(--ink)] border border-[var(--hairline)] hover:border-[var(--hairline-strong)]',
  danger: 'bg-transparent text-[var(--red)] border border-[var(--red)] hover:bg-[var(--red)] hover:text-white',
};

const sizeStyle: Record<'sm' | 'md' | 'lg', string> = {
  sm: 'min-h-[28px] px-3 text-[10px] tracking-[0.16em]',
  md: 'min-h-[36px] px-4 text-[11px] tracking-[0.16em]',
  lg: 'min-h-[44px] px-5 text-[12px] tracking-[0.16em]',
};

export function Button({
  variant = 'red',
  size = 'md',
  loading,
  className,
  children,
  disabled,
  style,
  ...props
}: ButtonProps) {
  const v = aliasV3[variant] ?? 'red';
  const base =
    'inline-flex items-center justify-center gap-[10px] uppercase font-bold leading-none ' +
    'rounded-none border-0 cursor-pointer disabled:cursor-not-allowed ' +
    'transition-all duration-150 ease-out focus:outline-none focus-visible:outline-none ' +
    'focus-visible:ring-2 focus-visible:ring-[var(--red)] focus-visible:ring-offset-0';

  return (
    <button
      className={cn(base, variantStyle[v], sizeStyle[size], 'relative', className)}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      style={{ fontFamily: 'var(--font-display)', ...style }}
      {...props}
    >
      <span className={cn('inline-flex items-center gap-[10px]', loading && 'invisible')}>
        {children}
      </span>
      {loading && (
        <span aria-live="polite" className="absolute inset-0 inline-flex items-center justify-center gap-1">
          <span className="w-1 h-1 bg-current animate-pulse" style={{ animationDelay: '0ms' }} />
          <span className="w-1 h-1 bg-current animate-pulse" style={{ animationDelay: '150ms' }} />
          <span className="w-1 h-1 bg-current animate-pulse" style={{ animationDelay: '300ms' }} />
        </span>
      )}
    </button>
  );
}
