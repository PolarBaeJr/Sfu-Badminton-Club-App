'use client';

import * as React from 'react';
import { Eyebrow } from './atoms-display';

/* ═══════════════════════════════════════════════════════════
   Player App v2 — layout atoms
   Phone/auth shells and screen scaffolding: status bar, screen
   header, card, section label, auth shell + auth header.
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
          <rect x="0" y="7" width="3" height="4" fill="#F2F2F2" />
          <rect x="4" y="5" width="3" height="6" fill="#F2F2F2" />
          <rect x="8" y="2" width="3" height="9" fill="#F2F2F2" />
          <rect x="12" y="0" width="3" height="11" fill="#F2F2F2" opacity="0.4" />
        </svg>
        <svg width="16" height="12" viewBox="0 0 16 12" fill="none">
          <path
            d="M8 2c2 0 4 1 5 2.5l-1 1C11 4 9.5 3.5 8 3.5S5 4 4 5.5l-1-1C4 3 6 2 8 2zM8 6c1 0 2 0.5 2.5 1l-1 1c-.5-.5-1-.5-1.5-.5s-1 0-1.5.5l-1-1C6 6.5 7 6 8 6zM8 9.5l1.5 1.5L8 11l-1.5-1.5z"
            fill="#F2F2F2"
          />
        </svg>
        <svg width="26" height="12" viewBox="0 0 26 12" fill="none">
          <rect x="0.5" y="0.5" width="22" height="11" rx="2.5" stroke="#F2F2F2" fill="none" />
          <rect x="2" y="2" width="18" height="8" rx="1" fill="#F2F2F2" />
          <rect x="23" y="3" width="2" height="6" rx="1" fill="#F2F2F2" />
        </svg>
      </div>
    </div>
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
        background: 'var(--surface1)',
        border: '1px solid var(--hairline)',
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
          color: 'var(--text)',
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
            color: 'var(--red)',
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

// ── AuthShell ──────────────────────────────────────────────
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
            <div style={{ height: 2, background: 'var(--surface2)', position: 'relative' }}>
              <div
                style={{
                  position: 'absolute',
                  top: 0,
                  left: 0,
                  height: 2,
                  width: progress + '%',
                  background: 'var(--red)',
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

// ── AuthHeader ─────────────────────────────────────────────
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
            color: 'var(--text)',
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
          color: 'var(--red)',
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
        <div style={{ fontSize: 13, color: 'var(--text)', lineHeight: 1.55, marginTop: 14 }}>{sub}</div>
      )}
    </div>
  );
}
