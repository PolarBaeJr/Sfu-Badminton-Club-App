'use client';

import React from 'react';
import { cn } from '../utils';

interface DropdownProps {
  trigger: React.ReactNode;
  items: { label: string; onClick: () => void; danger?: boolean }[];
}

export function Dropdown({ trigger, items }: DropdownProps) {
  const [open, setOpen] = React.useState(false);
  const ref = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (ref.current && !ref.current.contains(event.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  return (
    <div className="relative" ref={ref}>
      <div onClick={() => setOpen(!open)} className="min-h-[44px] min-w-[44px] flex items-center justify-center cursor-pointer">
        {trigger}
      </div>
      {open && (
        <div className="absolute right-0 mt-2 w-48 bg-[var(--bg-elevated)] border border-[var(--border)] rounded-lg shadow-xl z-50 py-1">
          {items.map((item, i) => (
            <button
              key={i}
              onClick={() => { item.onClick(); setOpen(false); }}
              className={cn(
                'w-full text-left px-4 min-h-[44px] text-sm hover:bg-[var(--border-hover)] transition-colors flex items-center',
                item.danger ? 'text-[var(--color-danger)]' : 'text-[var(--text-secondary)]'
              )}
            >
              {item.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
