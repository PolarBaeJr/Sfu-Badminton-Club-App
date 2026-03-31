'use client';

import React from 'react';
import { cn } from '../utils';

interface TabsProps {
  tabs: { id: string; label: string; count?: number }[];
  activeTab: string;
  onChange: (id: string) => void;
}

export function Tabs({ tabs, activeTab, onChange }: TabsProps) {
  return (
    <div className="flex gap-1 bg-[var(--bg-elevated)] p-1 rounded-lg overflow-x-auto">
      {tabs.map((tab) => (
        <button
          key={tab.id}
          onClick={() => onChange(tab.id)}
          className={cn(
            'px-4 min-h-[44px] text-sm rounded-md transition-colors whitespace-nowrap flex items-center gap-1.5',
            activeTab === tab.id
              ? 'bg-[var(--color-accent)] text-white'
              : 'text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--border-hover)]'
          )}
        >
          {tab.label}
          {tab.count !== undefined && (
            <span className={cn(
              'text-xs px-1.5 py-0.5 rounded-full',
              activeTab === tab.id ? 'bg-white/20' : 'bg-[var(--border-hover)]'
            )}>
              {tab.count}
            </span>
          )}
        </button>
      ))}
    </div>
  );
}
