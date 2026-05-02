import * as React from 'react';
import { cn } from '../utils';

export interface PageHeroProps {
  eyebrow: React.ReactNode;
  title: React.ReactNode;
  subtitle?: React.ReactNode;
  watermark?: React.ReactNode;
  /** Override the default headline scale. Default 52px; pass 64 for the player-app feel. */
  size?: 52 | 64;
  /** Watermark opacity. Default 0.04 (admin); player uses 0.08. */
  watermarkOpacity?: number;
  className?: string;
}

export function PageHero({
  eyebrow,
  title,
  subtitle,
  watermark,
  size = 52,
  watermarkOpacity = 0.04,
  className,
}: PageHeroProps) {
  return (
    <div
      className={cn('relative overflow-hidden', className)}
      style={{
        background: 'var(--surface1)',
        borderBottom: '1px solid var(--hairline)',
        padding: size === 64 ? '48px 48px 52px' : '40px 48px 44px',
      }}
    >
      {watermark != null && (
        <div
          className="absolute right-5 pointer-events-none select-none font-bold leading-none"
          style={{
            bottom: '-40px',
            fontFamily: 'var(--font-display)',
            fontWeight: 800,
            fontSize: '200px',
            color: 'var(--ink)',
            opacity: watermarkOpacity,
            letterSpacing: '-0.04em',
          }}
        >
          {watermark}
        </div>
      )}
      <div className="relative z-[2] max-w-[1400px]">
        <div className="flex items-center gap-[14px]">
          <span
            aria-hidden
            className="inline-block"
            style={{ width: '3px', height: '14px', background: 'var(--red)' }}
          />
          <span
            className="uppercase font-bold"
            style={{
              fontFamily: 'var(--font-body)',
              fontSize: '10px',
              letterSpacing: '0.2em',
              color: 'var(--red)',
            }}
          >
            {eyebrow}
          </span>
        </div>
        <h1
          className="font-bold"
          style={{
            fontFamily: 'var(--font-display)',
            fontWeight: 700,
            fontSize: size === 64 ? '64px' : '52px',
            lineHeight: size === 64 ? '0.92' : '1.0',
            letterSpacing: '-0.015em',
            color: 'var(--ink)',
            marginTop: size === 64 ? '16px' : '14px',
          }}
        >
          {title}
        </h1>
        {subtitle != null && (
          <p
            style={{
              color: 'var(--muted)',
              marginTop: size === 64 ? '14px' : '12px',
              maxWidth: size === 64 ? '480px' : '420px',
              fontSize: '13px',
              lineHeight: 1.6,
            }}
          >
            {subtitle}
          </p>
        )}
      </div>
    </div>
  );
}
