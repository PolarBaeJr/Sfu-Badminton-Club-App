'use client';

import React from 'react';
import { createPortal } from 'react-dom';
import { cn } from '../utils';

interface DropdownProps {
  trigger: React.ReactNode;
  /** `disabled` greys the item and makes it inert — for an action that is
   *  already in flight. It does NOT hide the item: a caller that means "this
   *  person may not do this" leaves the entry out of the array entirely. */
  items: { label: string; onClick: () => void; danger?: boolean; disabled?: boolean }[];
}

export function Dropdown({ trigger, items }: DropdownProps) {
  const [open, setOpen] = React.useState(false);
  const [pos, setPos] = React.useState<{ top: number; left: number; width: number } | null>(null);
  const triggerRef = React.useRef<HTMLDivElement>(null);
  const menuRef = React.useRef<HTMLDivElement>(null);

  // Recompute position when opened, on resize, and on scroll. Portal'd menu
  // doesn't move with its trigger otherwise — important inside scrollable
  // tables where the row scrolls horizontally.
  React.useEffect(() => {
    if (!open || !triggerRef.current) return;
    const updatePos = () => {
      const r = triggerRef.current?.getBoundingClientRect();
      if (!r) return;
      const menuW = 192;
      // Right-align menu under the trigger; clamp to viewport.
      const left = Math.max(8, Math.min(r.right - menuW, window.innerWidth - menuW - 8));
      const top = r.bottom + 6;
      setPos({ top, left, width: menuW });
    };
    updatePos();
    window.addEventListener('resize', updatePos);
    window.addEventListener('scroll', updatePos, true);
    return () => {
      window.removeEventListener('resize', updatePos);
      window.removeEventListener('scroll', updatePos, true);
    };
  }, [open]);

  React.useEffect(() => {
    if (!open) return;
    function handleClickOutside(event: MouseEvent) {
      const t = event.target as Node;
      if (triggerRef.current?.contains(t)) return;
      if (menuRef.current?.contains(t)) return;
      setOpen(false);
    }
    function handleEscape(event: KeyboardEvent) {
      if (event.key === 'Escape') setOpen(false);
    }
    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('keydown', handleEscape);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleEscape);
    };
  }, [open]);

  const menu =
    open && pos && typeof document !== 'undefined'
      ? createPortal(
          <div
            ref={menuRef}
            role="menu"
            style={{ position: 'fixed', top: pos.top, left: pos.left, width: pos.width, zIndex: 100 }}
            className="bg-[var(--bg-elevated)] border border-[var(--border)] rounded-lg shadow-xl py-1"
          >
            {items.map((item, i) => (
              <button
                key={i}
                role="menuitem"
                disabled={item.disabled}
                onClick={() => {
                  item.onClick();
                  setOpen(false);
                }}
                className={cn(
                  'w-full text-left px-4 min-h-[40px] text-sm hover:bg-[var(--border-hover)] transition-colors flex items-center',
                  'disabled:opacity-50 disabled:pointer-events-none',
                  item.danger ? 'text-[var(--color-danger)]' : 'text-[var(--text-secondary)]'
                )}
              >
                {item.label}
              </button>
            ))}
          </div>,
          document.body
        )
      : null;

  return (
    <>
      <div
        ref={triggerRef}
        onClick={() => setOpen((v) => !v)}
        className="min-h-[40px] min-w-[40px] flex items-center justify-center cursor-pointer"
      >
        {trigger}
      </div>
      {menu}
    </>
  );
}
