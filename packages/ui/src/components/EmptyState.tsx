'use client';

import React from 'react';

interface EmptyStateProps {
  title: string;
  description?: string;
  action?: React.ReactNode;
}

export function EmptyState({ title, description, action }: EmptyStateProps) {
  return (
    <div className="flex flex-col items-start py-12 px-6 max-w-md">
      <h3 className="ds-display text-[var(--text-primary)] text-xl font-semibold tracking-tight">{title}</h3>
      <div className="mt-3 h-px w-12 bg-[var(--ds-accent)]" aria-hidden />
      {description && (
        <p className="mt-3 text-[var(--text-secondary)] text-sm leading-relaxed">{description}</p>
      )}
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}
