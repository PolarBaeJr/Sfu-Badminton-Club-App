'use client';

import * as React from 'react';

/* ═══════════════════════════════════════════════════════════
   Player App v2 — form atoms
   Interactive controls: buttons, action tiles, settings rows,
   toggles, auth fields.
   ═══════════════════════════════════════════════════════════ */

// ── CTAButton ───────────────────────────────────────────────
type CTAVariant = 'primary' | 'ghost' | 'light' | 'danger';
type CTASize = 'sm' | 'md' | 'lg';

const CTA_SIZES: Record<CTASize, { h: number; px: number; fs: number; ls: string }> = {
  sm: { h: 36, px: 18, fs: 12, ls: '1.2px' },
  md: { h: 44, px: 24, fs: 13, ls: '1.4px' },
  lg: { h: 52, px: 32, fs: 14, ls: '1.4px' },
};
const CTA_VARIANTS: Record<CTAVariant, { bg: string; c: string; bd: string }> = {
  primary: { bg: 'var(--red)', c: '#F2F2F2', bd: 'none' },
  ghost:   { bg: 'transparent', c: '#F2F2F2', bd: '1px solid rgba(255,255,255,0.4)' },
  light:   { bg: '#F2F2F2', c: 'var(--surface1)', bd: 'none' },
  danger:  { bg: 'transparent', c: 'var(--red)', bd: '1px solid rgba(204,0,0,0.5)' },
};

export function CTAButton({
  children,
  onClick,
  variant = 'primary',
  size = 'md',
  full,
  type,
  disabled,
}: {
  children: React.ReactNode;
  onClick?: (e: React.MouseEvent<HTMLButtonElement>) => void;
  variant?: CTAVariant;
  size?: CTASize;
  full?: boolean;
  type?: 'button' | 'submit' | 'reset';
  disabled?: boolean;
}) {
  const sz = CTA_SIZES[size];
  const v = CTA_VARIANTS[variant];
  return (
    <button
      type={type ?? 'button'}
      onClick={onClick}
      disabled={disabled}
      style={{
        height: sz.h,
        padding: `0 ${sz.px}px`,
        background: v.bg,
        color: v.c,
        border: v.bd,
        borderRadius: 0,
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.6 : 1,
        fontFamily: 'inherit',
        fontSize: sz.fs,
        fontWeight: 700,
        letterSpacing: sz.ls,
        textTransform: 'uppercase',
        width: full ? '100%' : undefined,
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 8,
        transition: 'opacity 120ms ease, background 120ms ease',
      }}
      onMouseEnter={(e) => {
        if (variant === 'primary' && !disabled) e.currentTarget.style.background = 'var(--red-dark)';
      }}
      onMouseLeave={(e) => {
        if (variant === 'primary' && !disabled) e.currentTarget.style.background = 'var(--red)';
      }}
    >
      {children}
    </button>
  );
}

// ── ActionTile ─────────────────────────────────────────────
export function ActionTile({
  label,
  sub,
  icon,
  onClick,
  primary,
  href,
}: {
  label: string;
  sub: string;
  icon: React.ReactNode;
  onClick?: () => void;
  primary?: boolean;
  href?: string;
}) {
  const inner = (
    <>
      <div
        style={{
          width: 36,
          height: 36,
          background: primary ? 'rgba(255,255,255,0.15)' : 'rgba(204,0,0,0.12)',
          color: primary ? '#F2F2F2' : 'var(--red)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        {icon}
      </div>
      <div>
        <div style={{ fontSize: 14, fontWeight: 700, letterSpacing: '0.3px' }}>{label}</div>
        <div
          style={{
            fontSize: 11,
            color: primary ? 'rgba(255,255,255,0.7)' : 'var(--text)',
            marginTop: 2,
            fontWeight: 500,
          }}
        >
          {sub}
        </div>
      </div>
    </>
  );

  const style: React.CSSProperties = {
    background: primary ? 'var(--red)' : 'var(--surface1)',
    border: primary ? 'none' : '1px solid var(--hairline)',
    padding: '18px 16px',
    textAlign: 'left',
    cursor: 'pointer',
    color: '#F2F2F2',
    fontFamily: 'inherit',
    display: 'flex',
    flexDirection: 'column',
    gap: 12,
    transition: 'background 120ms ease',
    textDecoration: 'none',
  };

  if (href) {
    return (
      <a href={href} style={style}>
        {inner}
      </a>
    );
  }
  return (
    <button type="button" onClick={onClick} style={style}>
      {inner}
    </button>
  );
}

// ── Settings primitives ────────────────────────────────────
export function SettingsToggle({ on, onChange }: { on: boolean; onChange: () => void }) {
  return (
    <button
      type="button"
      onClick={onChange}
      style={{
        width: 44,
        height: 26,
        background: on ? 'rgba(204,0,0,0.15)' : 'var(--surface2)',
        border: on ? '1px solid var(--red)' : '1px solid var(--hairline)',
        position: 'relative',
        cursor: 'pointer',
        flexShrink: 0,
        padding: 0,
        transition: 'all 150ms',
      }}
      aria-pressed={on}
    >
      <span
        style={{
          position: 'absolute',
          top: 2,
          left: on ? 22 : 2,
          width: 18,
          height: 18,
          background: on ? 'var(--red)' : 'var(--dim)',
          transition: 'all 150ms',
        }}
      />
    </button>
  );
}

export function SettingsRow({
  label,
  hint,
  children,
  onClick,
  value,
}: {
  label: string;
  hint?: string;
  children?: React.ReactNode;
  onClick?: () => void;
  value?: string;
}) {
  return (
    <div
      onClick={onClick}
      style={{
        padding: '16px 18px',
        borderTop: '1px solid var(--hairline)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 16,
        cursor: onClick ? 'pointer' : 'default',
      }}
    >
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: '#F2F2F2' }}>{label}</div>
        {hint && (
          <div style={{ fontSize: 11, color: 'var(--text)', marginTop: 4, lineHeight: 1.4 }}>
            {hint}
          </div>
        )}
      </div>
      {children !== undefined ? (
        children
      ) : value !== undefined ? (
        <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontSize: 12, color: 'var(--text)', fontFamily: 'JetBrains Mono, monospace' }}>{value}</span>
          <span style={{ color: 'var(--dim)', fontSize: 18 }}>›</span>
        </span>
      ) : null}
    </div>
  );
}

export function SettingsGroup({ children }: { children: React.ReactNode }) {
  const arr = React.Children.toArray(children).filter(Boolean) as React.ReactElement[];
  return (
    <div style={{ background: 'var(--surface1)', border: '1px solid var(--hairline)', marginBottom: 20 }}>
      {arr.map((child, i) =>
        i === 0
          ? React.cloneElement(child, {
              key: i,
              style: { ...((child.props as { style?: React.CSSProperties }).style ?? {}), borderTop: 'none' },
            } as React.HTMLAttributes<HTMLDivElement>)
          : React.cloneElement(child, { key: i })
      )}
    </div>
  );
}

// ── AuthField ──────────────────────────────────────────────
export function AuthField({
  label,
  value,
  onChange,
  type = 'text',
  placeholder,
  error,
  autoFocus,
  hint,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  type?: string;
  placeholder?: string;
  error?: string;
  autoFocus?: boolean;
  hint?: string;
}) {
  const [focused, setFocused] = React.useState(false);
  return (
    <div style={{ marginBottom: 18 }}>
      <div
        style={{
          fontSize: 9,
          fontWeight: 600,
          letterSpacing: '1.5px',
          textTransform: 'uppercase',
          color: error ? 'var(--red)' : 'var(--dim)',
          marginBottom: 6,
        }}
      >
        {label}
      </div>
      <input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        autoFocus={autoFocus}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        style={{
          width: '100%',
          background: 'var(--surface1)',
          border: '1px solid',
          borderColor: error ? 'var(--red)' : focused ? 'var(--red)' : 'var(--hairline)',
          color: '#F2F2F2',
          fontSize: 14,
          fontWeight: 500,
          padding: '13px 14px',
          transition: 'border-color 150ms',
        }}
      />
      {hint && !error && (
        <div style={{ fontSize: 10, color: 'var(--dim)', marginTop: 6, lineHeight: 1.5 }}>{hint}</div>
      )}
      {error && (
        <div style={{ fontSize: 10, color: 'var(--red)', marginTop: 6, fontWeight: 600, letterSpacing: '0.04em' }}>
          ↑ {error}
        </div>
      )}
    </div>
  );
}
