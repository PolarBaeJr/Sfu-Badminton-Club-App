'use client';

import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Calendar, ChevronLeft, ChevronRight } from 'lucide-react';
import { cn } from '../utils';

const CAL_WIDTH = 280;
const CAL_HEIGHT = 348; // approx; used only to decide flip direction

interface DatePickerProps {
  label?: string;
  /** ISO date string, "YYYY-MM-DD", or '' */
  value: string;
  onChange: (value: string) => void;
  /** Inclusive min selectable date, "YYYY-MM-DD" */
  min?: string;
  /** Inclusive max selectable date, "YYYY-MM-DD" */
  max?: string;
  required?: boolean;
  disabled?: boolean;
  placeholder?: string;
  error?: string;
  id?: string;
  className?: string;
}

const WEEKDAYS = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];
const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

// Parse "YYYY-MM-DD" as a LOCAL date (avoids the UTC off-by-one that `new
// Date("YYYY-MM-DD")` causes in timezones behind UTC).
function parseISO(s: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return Number.isNaN(d.getTime()) ? null : d;
}

function toISO(d: Date): string {
  const y = d.getFullYear();
  const mo = String(d.getMonth() + 1).padStart(2, '0');
  const da = String(d.getDate()).padStart(2, '0');
  return `${y}-${mo}-${da}`;
}

function sameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

export const DatePicker = React.forwardRef<HTMLDivElement, DatePickerProps>(
  ({ label, value, onChange, min, max, required, disabled, placeholder = 'Select a date', error, id, className }, ref) => {
    const [open, setOpen] = useState(false);
    const selected = useMemo(() => parseISO(value), [value]);
    const minDate = useMemo(() => (min ? parseISO(min) : null), [min]);
    const maxDate = useMemo(() => (max ? parseISO(max) : null), [max]);
    const today = useMemo(() => { const d = new Date(); d.setHours(0, 0, 0, 0); return d; }, []);

    // Month currently shown in the calendar grid.
    const [viewMonth, setViewMonth] = useState<Date>(() => {
      const base = selected ?? today;
      return new Date(base.getFullYear(), base.getMonth(), 1);
    });

    const wrapRef = useRef<HTMLDivElement>(null);
    const triggerRef = useRef<HTMLButtonElement>(null);
    const calRef = useRef<HTMLDivElement>(null);
    const [coords, setCoords] = useState<{ top: number; left: number } | null>(null);
    const [mounted, setMounted] = useState(false);
    useEffect(() => setMounted(true), []);
    const inputId = id || (label ? label.toLowerCase().replace(/\s+/g, '-') : undefined);
    const errorId = inputId ? `${inputId}-error` : undefined;

    // Position the portaled calendar under (or above) the trigger, clamped to
    // the viewport. Fixed positioning escapes any overflow:hidden/auto ancestor
    // (e.g. the scrollable Dialog), so the calendar never clips.
    const reposition = () => {
      const el = triggerRef.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      const openUp = r.bottom + 8 + CAL_HEIGHT > window.innerHeight && r.top - 8 - CAL_HEIGHT > 0;
      const top = openUp ? r.top - 8 - CAL_HEIGHT : r.bottom + 8;
      const left = Math.min(Math.max(8, r.left), window.innerWidth - CAL_WIDTH - 8);
      setCoords({ top, left });
    };
    useLayoutEffect(() => {
      if (!open) return;
      reposition();
      window.addEventListener('scroll', reposition, true);
      window.addEventListener('resize', reposition);
      return () => {
        window.removeEventListener('scroll', reposition, true);
        window.removeEventListener('resize', reposition);
      };
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [open]);

    // Re-sync the visible month when the value changes while closed.
    useEffect(() => {
      if (!open) {
        const base = selected ?? today;
        setViewMonth(new Date(base.getFullYear(), base.getMonth(), 1));
      }
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [value]);

    // Close on outside click / Escape.
    useEffect(() => {
      if (!open) return;
      const onDown = (e: MouseEvent) => {
        const t = e.target as Node;
        const inTrigger = wrapRef.current?.contains(t);
        const inCal = calRef.current?.contains(t);
        if (!inTrigger && !inCal) setOpen(false);
      };
      const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
      document.addEventListener('mousedown', onDown);
      document.addEventListener('keydown', onKey);
      return () => {
        document.removeEventListener('mousedown', onDown);
        document.removeEventListener('keydown', onKey);
      };
    }, [open]);

    const isDisabledDay = (d: Date) =>
      (minDate ? d < minDate : false) || (maxDate ? d > maxDate : false);

    const cells = useMemo(() => {
      const year = viewMonth.getFullYear();
      const month = viewMonth.getMonth();
      const firstWeekday = new Date(year, month, 1).getDay(); // 0=Sun
      const daysInMonth = new Date(year, month + 1, 0).getDate();
      const out: (Date | null)[] = [];
      for (let i = 0; i < firstWeekday; i++) out.push(null);
      for (let day = 1; day <= daysInMonth; day++) out.push(new Date(year, month, day));
      while (out.length % 7 !== 0) out.push(null);
      return out;
    }, [viewMonth]);

    const display = selected
      ? selected.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
      : '';

    const shiftMonth = (delta: number) =>
      setViewMonth((m) => new Date(m.getFullYear(), m.getMonth() + delta, 1));

    return (
      <div className="space-y-1" ref={ref}>
        {label && (
          <label htmlFor={inputId} className="block text-[13px] font-medium text-[var(--text-secondary)] mb-1.5">
            {label}
            {required && <span className="text-[var(--color-accent)]"> *</span>}
          </label>
        )}

        <div className="relative" ref={wrapRef}>
          <button
            type="button"
            ref={triggerRef}
            id={inputId}
            disabled={disabled}
            aria-haspopup="dialog"
            aria-expanded={open}
            aria-invalid={!!error}
            aria-describedby={error && errorId ? errorId : undefined}
            onClick={() => !disabled && setOpen((o) => !o)}
            className={cn(
              'w-full px-3 min-h-[48px] flex items-center gap-2 text-left bg-[var(--bg-surface)] border border-[var(--border)] rounded-[8px] text-[var(--text-primary)] transition-colors',
              'focus:outline-none focus:ring-2 focus:ring-[var(--color-accent)] focus:border-transparent',
              'hover:border-[var(--border-hover)] disabled:opacity-50 disabled:cursor-not-allowed',
              open && 'ring-2 ring-[var(--color-accent)] border-transparent',
              error && 'border-[var(--color-danger)] focus:ring-[var(--color-danger)]',
              className,
            )}
          >
            <Calendar className="w-4 h-4 shrink-0 text-[var(--text-muted)]" />
            <span className={cn('flex-1 truncate', !display && 'text-[var(--text-muted)]')}>
              {display || placeholder}
            </span>
          </button>

          {open && mounted && coords && createPortal(
            <div
              ref={calRef}
              role="dialog"
              aria-label="Choose date"
              className="p-3 bg-[var(--bg-surface)] border border-[var(--border)] rounded-[12px]"
              style={{ position: 'fixed', top: coords.top, left: coords.left, width: CAL_WIDTH, zIndex: 60, boxShadow: '0 10px 40px -12px rgba(0,0,0,0.45)' }}
            >
              {/* Header */}
              <div className="flex items-center justify-between mb-2">
                <button
                  type="button"
                  onClick={() => shiftMonth(-1)}
                  aria-label="Previous month"
                  className="w-8 h-8 flex items-center justify-center rounded-lg text-[var(--text-secondary)] hover:bg-[var(--bg-elevated)] hover:text-[var(--text-primary)] transition-colors"
                >
                  <ChevronLeft className="w-4 h-4" />
                </button>
                <div className="text-[13px] font-semibold text-[var(--text-primary)]">
                  {MONTHS[viewMonth.getMonth()]} {viewMonth.getFullYear()}
                </div>
                <button
                  type="button"
                  onClick={() => shiftMonth(1)}
                  aria-label="Next month"
                  className="w-8 h-8 flex items-center justify-center rounded-lg text-[var(--text-secondary)] hover:bg-[var(--bg-elevated)] hover:text-[var(--text-primary)] transition-colors"
                >
                  <ChevronRight className="w-4 h-4" />
                </button>
              </div>

              {/* Weekday labels */}
              <div className="grid grid-cols-7 mb-1">
                {WEEKDAYS.map((w, i) => (
                  <div key={i} className="h-7 flex items-center justify-center text-[11px] font-medium text-[var(--text-muted)]">
                    {w}
                  </div>
                ))}
              </div>

              {/* Day grid */}
              <div className="grid grid-cols-7 gap-0.5">
                {cells.map((d, i) => {
                  if (!d) return <div key={i} className="h-9" />;
                  const isSel = selected ? sameDay(d, selected) : false;
                  const isToday = sameDay(d, today);
                  const disabledDay = isDisabledDay(d);
                  return (
                    <button
                      key={i}
                      type="button"
                      disabled={disabledDay}
                      onClick={() => { onChange(toISO(d)); setOpen(false); }}
                      className={cn(
                        'h-9 w-full flex items-center justify-center rounded-lg text-[13px] transition-colors',
                        !disabledDay && !isSel && 'text-[var(--text-primary)] hover:bg-[var(--bg-elevated)]',
                        isSel && 'bg-[var(--color-accent)] text-white font-semibold',
                        isToday && !isSel && 'font-semibold text-[var(--color-accent)] ring-1 ring-inset ring-[var(--color-accent)]',
                        disabledDay && 'text-[var(--text-muted)] opacity-40 cursor-not-allowed',
                      )}
                    >
                      {d.getDate()}
                    </button>
                  );
                })}
              </div>

              {/* Footer: quick actions */}
              <div className="flex items-center justify-between mt-2 pt-2 border-t border-[var(--border)]">
                <button
                  type="button"
                  disabled={isDisabledDay(today)}
                  onClick={() => { onChange(toISO(today)); setOpen(false); }}
                  className="text-[12px] font-medium text-[var(--color-accent)] hover:underline disabled:opacity-40 disabled:no-underline disabled:cursor-not-allowed"
                >
                  Today
                </button>
                {value && !required && (
                  <button
                    type="button"
                    onClick={() => { onChange(''); setOpen(false); }}
                    className="text-[12px] font-medium text-[var(--text-muted)] hover:text-[var(--text-secondary)]"
                  >
                    Clear
                  </button>
                )}
              </div>
            </div>,
            document.body,
          )}
        </div>

        {error && <p id={errorId} className="text-sm text-[var(--color-danger)]">{error}</p>}
      </div>
    );
  },
);
DatePicker.displayName = 'DatePicker';
