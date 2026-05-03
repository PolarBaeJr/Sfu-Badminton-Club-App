'use client';

import * as React from 'react';

/* ═══════════════════════════════════════════════════════════
   Player App v2 — display atoms
   Pure visual elements (no interaction): brand glyph, avatar,
   eyebrows, pills, empty states.
   ═══════════════════════════════════════════════════════════ */

// ── ShuttleMark ─────────────────────────────────────────────
export function ShuttleMark({ size = 22, color = 'var(--ink)' }: { size?: number; color?: string }) {
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
        color: color ?? 'var(--red)',
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
        color: color ?? 'var(--ink)',
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
  confirmed:    { c: 'var(--green)', bg: 'rgba(3,144,74,0.12)',   bd: 'rgba(3,144,74,0.35)' },
  approved:     { c: 'var(--green)', bg: 'rgba(3,144,74,0.12)',   bd: 'rgba(3,144,74,0.35)' },
  pending:      { c: 'var(--warning)', bg: 'rgba(245,158,11,0.12)', bd: 'rgba(245,158,11,0.35)' },
  pending_approval: { c: 'var(--warning)', bg: 'rgba(245,158,11,0.12)', bd: 'rgba(245,158,11,0.35)' },
  disputed:     { c: 'var(--red)', bg: 'rgba(204,0,0,0.12)',  bd: 'rgba(204,0,0,0.35)' },
  competitive:  { c: 'var(--red)', bg: 'rgba(204,0,0,0.12)',  bd: 'rgba(204,0,0,0.35)' },
  recreational: { c: 'var(--text)', bg: 'rgba(255,255,255,0.05)', bd: 'rgba(255,255,255,0.15)' },
  session:      { c: 'var(--info)', bg: 'rgba(76,152,185,0.12)', bd: 'rgba(76,152,185,0.35)' },
  match:        { c: 'var(--green)', bg: 'rgba(3,144,74,0.12)',   bd: 'rgba(3,144,74,0.35)' },
  announce:     { c: 'var(--ink)',    bg: 'rgba(255,255,255,0.06)', bd: 'rgba(255,255,255,0.18)' },
  open:         { c: 'var(--green)', bg: 'rgba(3,144,74,0.12)',   bd: 'rgba(3,144,74,0.35)' },
  closed:       { c: 'var(--text)', bg: 'rgba(255,255,255,0.05)', bd: 'rgba(255,255,255,0.15)' },
  featured:     { c: 'var(--red)', bg: 'rgba(204,0,0,0.12)',  bd: 'rgba(204,0,0,0.35)' },
};

const FALLBACK_STATUS = { c: 'var(--text)', bg: 'rgba(255,255,255,0.05)', bd: 'rgba(255,255,255,0.15)' };

export function StatusPill({ status }: { status: string }) {
  const s = STATUS_COLOR_MAP[status] ?? FALLBACK_STATUS;
  return (
    <Pill color={s.c} bg={s.bg} border={`1px solid ${s.bd}`}>
      {status.replace(/_/g, ' ')}
    </Pill>
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
      {icon && <div style={{ marginBottom: 6, color: 'var(--dim)' }}>{icon}</div>}
      <div style={{ fontSize: 14, fontWeight: 600 }}>{title}</div>
      {hint && (
        <div style={{ fontSize: 12, color: 'var(--text)', maxWidth: 240, lineHeight: 1.5 }}>{hint}</div>
      )}
    </div>
  );
}
