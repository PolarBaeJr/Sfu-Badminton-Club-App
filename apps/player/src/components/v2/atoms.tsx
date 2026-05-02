'use client';

import * as React from 'react';

/* ═══════════════════════════════════════════════════════════
   Player App v2 — atoms (pixel-faithful port from Player App v2.html)
   ═══════════════════════════════════════════════════════════ */

// ── StatusBar ───────────────────────────────────────────────
export function StatusBar() {
  return (
    <div
      style={{
        height: 50,
        padding: '14px 28px 4px',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        flexShrink: 0,
        position: 'relative',
        zIndex: 60,
      }}
    >
      <span style={{ fontSize: 15, fontWeight: 600, fontFamily: 'JetBrains Mono, monospace' }}>9:41</span>
      <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
        <svg width="17" height="11" viewBox="0 0 17 11" fill="none">
          <rect x="0" y="7" width="3" height="4" fill="#fff" />
          <rect x="4" y="5" width="3" height="6" fill="#fff" />
          <rect x="8" y="2" width="3" height="9" fill="#fff" />
          <rect x="12" y="0" width="3" height="11" fill="#fff" opacity="0.4" />
        </svg>
        <svg width="16" height="12" viewBox="0 0 16 12" fill="none">
          <path
            d="M8 2c2 0 4 1 5 2.5l-1 1C11 4 9.5 3.5 8 3.5S5 4 4 5.5l-1-1C4 3 6 2 8 2zM8 6c1 0 2 0.5 2.5 1l-1 1c-.5-.5-1-.5-1.5-.5s-1 0-1.5.5l-1-1C6 6.5 7 6 8 6zM8 9.5l1.5 1.5L8 11l-1.5-1.5z"
            fill="#fff"
          />
        </svg>
        <svg width="26" height="12" viewBox="0 0 26 12" fill="none">
          <rect x="0.5" y="0.5" width="22" height="11" rx="2.5" stroke="#fff" fill="none" />
          <rect x="2" y="2" width="18" height="8" rx="1" fill="#fff" />
          <rect x="23" y="3" width="2" height="6" rx="1" fill="#fff" />
        </svg>
      </div>
    </div>
  );
}

// ── ShuttleMark ─────────────────────────────────────────────
export function ShuttleMark({ size = 22, color = '#fff' }: { size?: number; color?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" style={{ flexShrink: 0 }}>
      <circle cx="12" cy="18" r="3.5" fill={color} />
      <path d="M12 14 L7 4 L9 4 L12 13 Z" fill={color} opacity="0.85" />
      <path d="M12 14 L17 4 L15 4 L12 13 Z" fill={color} opacity="0.85" />
      <path d="M12 14 L4 7 L6 5 L12 13 Z" fill={color} opacity="0.6" />
      <path d="M12 14 L20 7 L18 5 L12 13 Z" fill={color} opacity="0.6" />
    </svg>
  );
}

// ── Avatar ──────────────────────────────────────────────────
export function Avatar({
  name = '',
  size = 36,
  ring = false,
  src,
}: {
  name?: string;
  size?: number;
  ring?: boolean;
  src?: string | null;
}) {
  const initials = name
    .split(' ')
    .map((p) => p[0])
    .slice(0, 2)
    .join('')
    .toUpperCase();
  const hue =
    name.split('').reduce((n, c) => n + c.charCodeAt(0), 0) % 360;
  if (src) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={src}
        alt={name}
        style={{
          width: size,
          height: size,
          objectFit: 'cover',
          flexShrink: 0,
          border: ring ? '1px solid rgba(255,255,255,0.18)' : 'none',
          background: `oklch(28% 0.06 ${hue})`,
        }}
      />
    );
  }
  return (
    <div
      style={{
        width: size,
        height: size,
        flexShrink: 0,
        background: `oklch(28% 0.06 ${hue})`,
        color: `oklch(82% 0.07 ${hue})`,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontSize: size * 0.36,
        fontWeight: 600,
        fontFamily: 'inherit',
        border: ring ? '1px solid rgba(255,255,255,0.18)' : 'none',
      }}
    >
      {initials}
    </div>
  );
}

// ── Eyebrow ─────────────────────────────────────────────────
export function Eyebrow({ children, color }: { children: React.ReactNode; color?: string }) {
  return (
    <div
      style={{
        color: color ?? '#da291c',
        fontSize: 11,
        fontWeight: 600,
        letterSpacing: '1.1px',
        textTransform: 'uppercase',
      }}
    >
      {children}
    </div>
  );
}

// ── Pill / StatusPill ───────────────────────────────────────
export function Pill({
  children,
  color,
  bg,
  border,
}: {
  children: React.ReactNode;
  color?: string;
  bg?: string;
  border?: string;
}) {
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 4,
        padding: '3px 10px',
        fontSize: 10,
        fontWeight: 700,
        letterSpacing: '1px',
        textTransform: 'uppercase',
        color: color ?? '#fff',
        background: bg ?? 'transparent',
        border: border ?? '1px solid rgba(255,255,255,0.2)',
        whiteSpace: 'nowrap',
      }}
    >
      {children}
    </span>
  );
}

const STATUS_COLOR_MAP: Record<string, { c: string; bg: string; bd: string }> = {
  confirmed:    { c: '#03904a', bg: 'rgba(3,144,74,0.12)',   bd: 'rgba(3,144,74,0.35)' },
  approved:     { c: '#03904a', bg: 'rgba(3,144,74,0.12)',   bd: 'rgba(3,144,74,0.35)' },
  pending:      { c: '#f59e0b', bg: 'rgba(245,158,11,0.12)', bd: 'rgba(245,158,11,0.35)' },
  pending_approval: { c: '#f59e0b', bg: 'rgba(245,158,11,0.12)', bd: 'rgba(245,158,11,0.35)' },
  disputed:     { c: '#da291c', bg: 'rgba(218,41,28,0.12)',  bd: 'rgba(218,41,28,0.35)' },
  competitive:  { c: '#da291c', bg: 'rgba(218,41,28,0.12)',  bd: 'rgba(218,41,28,0.35)' },
  recreational: { c: '#969696', bg: 'rgba(255,255,255,0.05)', bd: 'rgba(255,255,255,0.15)' },
  session:      { c: '#4c98b9', bg: 'rgba(76,152,185,0.12)', bd: 'rgba(76,152,185,0.35)' },
  match:        { c: '#03904a', bg: 'rgba(3,144,74,0.12)',   bd: 'rgba(3,144,74,0.35)' },
  announce:     { c: '#fff',    bg: 'rgba(255,255,255,0.06)', bd: 'rgba(255,255,255,0.18)' },
  open:         { c: '#03904a', bg: 'rgba(3,144,74,0.12)',   bd: 'rgba(3,144,74,0.35)' },
  closed:       { c: '#969696', bg: 'rgba(255,255,255,0.05)', bd: 'rgba(255,255,255,0.15)' },
  featured:     { c: '#da291c', bg: 'rgba(218,41,28,0.12)',  bd: 'rgba(218,41,28,0.35)' },
};

const FALLBACK_STATUS = { c: '#969696', bg: 'rgba(255,255,255,0.05)', bd: 'rgba(255,255,255,0.15)' };

export function StatusPill({ status }: { status: string }) {
  const s = STATUS_COLOR_MAP[status] ?? FALLBACK_STATUS;
  return (
    <Pill color={s.c} bg={s.bg} border={`1px solid ${s.bd}`}>
      {status.replace(/_/g, ' ')}
    </Pill>
  );
}

// ── CTAButton ───────────────────────────────────────────────
type CTAVariant = 'primary' | 'ghost' | 'light' | 'danger';
type CTASize = 'sm' | 'md' | 'lg';

const CTA_SIZES: Record<CTASize, { h: number; px: number; fs: number; ls: string }> = {
  sm: { h: 36, px: 18, fs: 12, ls: '1.2px' },
  md: { h: 44, px: 24, fs: 13, ls: '1.4px' },
  lg: { h: 52, px: 32, fs: 14, ls: '1.4px' },
};
const CTA_VARIANTS: Record<CTAVariant, { bg: string; c: string; bd: string }> = {
  primary: { bg: '#da291c', c: '#fff', bd: 'none' },
  ghost:   { bg: 'transparent', c: '#fff', bd: '1px solid rgba(255,255,255,0.4)' },
  light:   { bg: '#fff', c: '#181818', bd: 'none' },
  danger:  { bg: 'transparent', c: '#da291c', bd: '1px solid rgba(218,41,28,0.5)' },
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
        if (variant === 'primary' && !disabled) e.currentTarget.style.background = '#b01e0a';
      }}
      onMouseLeave={(e) => {
        if (variant === 'primary' && !disabled) e.currentTarget.style.background = '#da291c';
      }}
    >
      {children}
    </button>
  );
}

// ── ScreenHeader ────────────────────────────────────────────
export function ScreenHeader({
  eyebrow,
  title,
  action,
}: {
  eyebrow?: React.ReactNode;
  title: React.ReactNode;
  action?: React.ReactNode;
}) {
  return (
    <div
      style={{
        padding: '8px 24px 20px',
        display: 'flex',
        alignItems: 'flex-end',
        gap: 16,
        animation: 'fadeUp 320ms ease both',
      }}
    >
      <div style={{ flex: 1, minWidth: 0 }}>
        {eyebrow && <Eyebrow>{eyebrow}</Eyebrow>}
        <h1
          style={{
            fontSize: 32,
            fontWeight: 500,
            letterSpacing: '-0.6px',
            lineHeight: 1.05,
            marginTop: 6,
          }}
        >
          {title}
        </h1>
      </div>
      {action}
    </div>
  );
}

// ── Card ───────────────────────────────────────────────────
export function Card({
  children,
  padding = 20,
  style,
}: {
  children: React.ReactNode;
  padding?: number;
  style?: React.CSSProperties;
}) {
  return (
    <div
      style={{
        background: '#222',
        border: '1px solid #303030',
        padding,
        ...style,
      }}
    >
      {children}
    </div>
  );
}

// ── SectionLabel ───────────────────────────────────────────
export function SectionLabel({
  children,
  action,
  onAction,
}: {
  children: React.ReactNode;
  action?: React.ReactNode;
  onAction?: () => void;
}) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        marginBottom: 12,
      }}
    >
      <span
        style={{
          fontSize: 10,
          fontWeight: 600,
          letterSpacing: '1.6px',
          textTransform: 'uppercase',
          color: '#969696',
        }}
      >
        {children}
      </span>
      {action && (
        <button
          type="button"
          onClick={onAction}
          style={{
            background: 'none',
            border: 'none',
            color: '#da291c',
            fontSize: 10,
            fontWeight: 700,
            letterSpacing: '1.4px',
            textTransform: 'uppercase',
            cursor: 'pointer',
            padding: 0,
            fontFamily: 'inherit',
          }}
        >
          {action}
        </button>
      )}
    </div>
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
          background: primary ? 'rgba(255,255,255,0.15)' : 'rgba(218,41,28,0.12)',
          color: primary ? '#fff' : '#da291c',
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
            color: primary ? 'rgba(255,255,255,0.7)' : '#969696',
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
    background: primary ? '#da291c' : '#222',
    border: primary ? 'none' : '1px solid #303030',
    padding: '18px 16px',
    textAlign: 'left',
    cursor: 'pointer',
    color: '#fff',
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
        background: on ? 'rgba(218,41,28,0.15)' : '#1a1a1a',
        border: on ? '1px solid #da291c' : '1px solid #303030',
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
          background: on ? '#da291c' : '#666',
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
        borderTop: '1px solid #303030',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 16,
        cursor: onClick ? 'pointer' : 'default',
      }}
    >
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: '#fff' }}>{label}</div>
        {hint && (
          <div style={{ fontSize: 11, color: '#969696', marginTop: 4, lineHeight: 1.4 }}>
            {hint}
          </div>
        )}
      </div>
      {children !== undefined ? (
        children
      ) : value !== undefined ? (
        <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontSize: 12, color: '#969696', fontFamily: 'JetBrains Mono, monospace' }}>{value}</span>
          <span style={{ color: '#666', fontSize: 18 }}>›</span>
        </span>
      ) : null}
    </div>
  );
}

export function SettingsGroup({ children }: { children: React.ReactNode }) {
  const arr = React.Children.toArray(children).filter(Boolean) as React.ReactElement[];
  return (
    <div style={{ background: '#222', border: '1px solid #303030', marginBottom: 20 }}>
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

// ── Auth primitives ────────────────────────────────────────
export function AuthShell({
  children,
  progress,
}: {
  children: React.ReactNode;
  progress?: number;
}) {
  return (
    <div className="auth-stage">
      <div className="auth-phone">
        <div className="notch" />
        <div className="auth-phone-screen">
          <StatusBar />
          {progress != null && (
            <div style={{ height: 2, background: '#1a1a1a', position: 'relative' }}>
              <div
                style={{
                  position: 'absolute',
                  top: 0,
                  left: 0,
                  height: 2,
                  width: progress + '%',
                  background: '#da291c',
                  transition: 'width 280ms cubic-bezier(0.2,0.8,0.2,1)',
                }}
              />
            </div>
          )}
          <div className="scroll" style={{ flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column' }}>
            {children}
          </div>
        </div>
      </div>
    </div>
  );
}

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
          color: error ? '#da291c' : '#666',
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
          background: '#181818',
          border: '1px solid',
          borderColor: error ? '#da291c' : focused ? '#da291c' : '#303030',
          color: '#fff',
          fontSize: 14,
          fontWeight: 500,
          padding: '13px 14px',
          transition: 'border-color 150ms',
        }}
      />
      {hint && !error && (
        <div style={{ fontSize: 10, color: '#666', marginTop: 6, lineHeight: 1.5 }}>{hint}</div>
      )}
      {error && (
        <div style={{ fontSize: 10, color: '#da291c', marginTop: 6, fontWeight: 600, letterSpacing: '0.04em' }}>
          ↑ {error}
        </div>
      )}
    </div>
  );
}

export function AuthHeader({
  eyebrow,
  title,
  sub,
  onBack,
}: {
  eyebrow: React.ReactNode;
  title: React.ReactNode;
  sub?: React.ReactNode;
  onBack?: () => void;
}) {
  return (
    <div style={{ padding: '28px 24px 0' }}>
      {onBack && (
        <button
          type="button"
          onClick={onBack}
          style={{
            background: 'transparent',
            border: 0,
            color: '#969696',
            fontSize: 12,
            fontWeight: 600,
            letterSpacing: '0.06em',
            padding: 0,
            marginBottom: 22,
            cursor: 'pointer',
            fontFamily: 'inherit',
          }}
        >
          ← Back
        </button>
      )}
      <div
        style={{
          fontSize: 10,
          fontWeight: 700,
          letterSpacing: '2.4px',
          textTransform: 'uppercase',
          color: '#da291c',
        }}
      >
        {eyebrow}
      </div>
      <div
        style={{
          fontSize: 32,
          fontWeight: 700,
          letterSpacing: '-0.8px',
          lineHeight: 1.05,
          marginTop: 8,
        }}
      >
        {title}
      </div>
      {sub && (
        <div style={{ fontSize: 13, color: '#969696', lineHeight: 1.55, marginTop: 14 }}>{sub}</div>
      )}
    </div>
  );
}

// ── Empty state ────────────────────────────────────────────
export function EmptyState({
  title,
  hint,
  icon,
}: {
  title: string;
  hint?: string;
  icon?: React.ReactNode;
}) {
  return (
    <div
      style={{
        padding: '40px 24px',
        textAlign: 'center',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: 8,
      }}
    >
      {icon && <div style={{ marginBottom: 6, color: '#666' }}>{icon}</div>}
      <div style={{ fontSize: 14, fontWeight: 600 }}>{title}</div>
      {hint && (
        <div style={{ fontSize: 12, color: '#969696', maxWidth: 240, lineHeight: 1.5 }}>{hint}</div>
      )}
    </div>
  );
}
