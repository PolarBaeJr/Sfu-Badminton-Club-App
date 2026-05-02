'use client';

import React from 'react';
import { cn } from '../utils';

export type DeltaVariant = 'default' | 'up' | 'down' | 'warn' | 'action';

interface StatCardProps {
  label: string;
  value: React.ReactNode;
  /** v3 delta text */
  delta?: React.ReactNode;
  deltaVariant?: DeltaVariant;
  /** Legacy alias for delta */
  change?: string;
  changeType?: 'positive' | 'negative' | 'neutral';
  /** Make the value text red */
  highlight?: boolean;
  className?: string;
}

const deltaColors: Record<DeltaVariant, string> = {
  default: 'var(--dim)',
  up:      'var(--green)',
  down:    'var(--red)',
  warn:    'var(--amber)',
  action:  'var(--red)',
};

const legacyMap: Record<NonNullable<StatCardProps['changeType']>, DeltaVariant> = {
  positive: 'up',
  negative: 'down',
  neutral:  'default',
};

export function StatCard({
  label,
  value,
  delta,
  deltaVariant,
  change,
  changeType,
  highlight,
  className,
}: StatCardProps) {
  const finalDelta = delta ?? change;
  const finalVariant: DeltaVariant =
    deltaVariant ?? (changeType ? legacyMap[changeType] : 'default');

  return (
    <div
      className={cn('p-6 transition-colors duration-150 ease-out hover:bg-[var(--surface2)]', className)}
      style={{ background: 'var(--surface1)' }}
    >
      <div
        className="font-bold uppercase"
        style={{
          fontSize: '9px',
          letterSpacing: '0.18em',
          color: 'var(--faint)',
          fontFamily: 'var(--font-body)',
        }}
      >
        {label}
      </div>
      <div
        className="font-bold mt-[14px] leading-none"
        style={{
          fontFamily: 'var(--font-display)',
          fontSize: '52px',
          letterSpacing: '-0.02em',
          fontVariantNumeric: 'tabular-nums',
          color: highlight ? 'var(--red)' : 'var(--ink)',
        }}
      >
        {value}
      </div>
      {finalDelta != null && (
        <div
          className="mt-2"
          style={{
            fontSize: '11px',
            letterSpacing: '0.04em',
            color: deltaColors[finalVariant],
          }}
        >
          {finalDelta}
        </div>
      )}
    </div>
  );
}
