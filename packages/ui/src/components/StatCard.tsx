'use client';

import React from 'react';
import { cn } from '../utils';
import { Card } from './Card';

interface StatCardProps {
  label: string;
  value: string | number;
  change?: string;
  changeType?: 'positive' | 'negative' | 'neutral';
}

export function StatCard({ label, value, change, changeType = 'neutral' }: StatCardProps) {
  const changeColors = {
    positive: 'text-[var(--color-success)]',
    negative: 'text-[var(--color-danger)]',
    neutral: 'text-[var(--text-muted)]',
  };

  return (
    <Card>
      <p className="text-[10px] uppercase tracking-wide text-[var(--text-muted)]">{label}</p>
      <p className="text-4xl font-bold text-[var(--text-primary)] font-display mt-1">{value}</p>
      {change && <p className={cn('text-sm mt-1', changeColors[changeType])}>{change}</p>}
    </Card>
  );
}
