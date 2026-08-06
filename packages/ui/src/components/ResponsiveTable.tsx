'use client';

import React from 'react';
import { cn } from '../utils';

/**
 * Two renderings of one dataset.
 *
 * The admin console is used from a phone (execs check members in at the door),
 * but every data table was a wide desktop table in an `overflow-x-auto` box:
 * three of eight columns visible, a horizontal scrollbar, and cells so narrow
 * that values broke mid-token — a score column rendering `21-` / `2,` / `21-2`
 * on three lines.
 *
 * `children` is the existing table, untouched, shown from `md` up. `cards` is
 * a stacked card per row, shown below `md`. Nothing about the desktop markup
 * changes, so nothing about the desktop rendering can change.
 */
interface ResponsiveTableProps {
  /** The existing `<table>` markup. Rendered verbatim at `md` and up. */
  children: React.ReactNode;
  /** One `<TableCard>` per row. The only thing rendered below `md`. */
  cards: React.ReactNode;
  /** Extra classes for the desktop scroll wrapper. */
  className?: string;
}

export function ResponsiveTable({ children, cards, className }: ResponsiveTableProps) {
  return (
    <>
      <div className={cn('hidden md:block overflow-x-auto', className)}>{children}</div>
      {/* Rows are divided, not boxed: every caller already sits inside a
          bordered <Card>, and a border per row would double the chrome. */}
      <div className="md:hidden divide-y divide-[var(--border)]">{cards}</div>
    </>
  );
}

export interface TableCardField {
  label: string;
  value: React.ReactNode;
  /** Span both columns — for values that are lists or long prose. */
  wide?: boolean;
}

interface TableCardProps {
  /** Primary identity: the players, the person, the name. Gets its own line. */
  title: React.ReactNode;
  /** The one number that matters: score, amount, date. */
  value?: React.ReactNode;
  /** Status pills, sat under the title. */
  badges?: React.ReactNode;
  /** Secondary columns, as labelled pairs. */
  fields?: TableCardField[];
  /** Row actions. Pinned to the bottom, sized for a thumb. */
  actions?: React.ReactNode;
  /** Escape hatch for row content no page shares — matches' dispute and
   *  walkover call-outs, for instance. Renders below the fields. */
  children?: React.ReactNode;
  className?: string;
}

export function TableCard({
  title,
  value,
  badges,
  fields,
  actions,
  children,
  className,
}: TableCardProps) {
  const visibleFields = fields?.filter((f) => f.value != null && f.value !== '');
  return (
    // `anywhere` is the safety net, not the strategy: <Atomic> keeps real
    // tokens whole, and this only ever fires on a single word wider than the
    // card, which would otherwise push the page sideways.
    <div className={cn('px-4 py-4 [overflow-wrap:anywhere]', className)}>
      <div className="text-sm font-semibold leading-snug text-[var(--text-primary)]">{title}</div>

      {value != null && value !== '' && (
        <div className="mt-1.5 font-mono text-[15px] font-semibold text-[var(--text-primary)]">
          {value}
        </div>
      )}

      {badges && <div className="mt-2 flex flex-wrap items-center gap-1.5">{badges}</div>}

      {visibleFields && visibleFields.length > 0 && (
        <dl className="mt-3 grid grid-cols-2 gap-x-3 gap-y-2.5">
          {visibleFields.map((f) => (
            <div key={f.label} className={cn('min-w-0', f.wide && 'col-span-2')}>
              <dt className="font-mono text-[10px] font-medium uppercase tracking-[0.1em] text-[var(--text-muted)]">
                {f.label}
              </dt>
              <dd className="mt-0.5 text-sm text-[var(--text-secondary)]">{f.value}</dd>
            </div>
          ))}
        </dl>
      )}

      {children}

      {actions && (
        // 44px floor on every control in the slot — the pages hand us `sm`
        // buttons and icon triggers sized for a mouse.
        <div className="mt-3 flex flex-wrap items-center gap-2 [&_a]:min-h-[44px] [&_button]:min-h-[44px] [&_button]:min-w-[44px] [&_button]:justify-center">
          {actions}
        </div>
      )}
    </div>
  );
}

interface AtomicProps {
  children: React.ReactNode;
  /**
   * Split a string child on this delimiter and allow a line break only
   * between the pieces. `separator=","` turns `21-2, 21-2` into two chunks
   * that wrap as units — never `21-` / `2,`, which is what a hyphen invites.
   */
  separator?: string;
  className?: string;
}

/** A value that must not be broken across lines. */
export function Atomic({ children, separator, className }: AtomicProps) {
  if (separator && typeof children === 'string' && children.includes(separator)) {
    const parts = children.split(separator);
    return (
      <span className={cn('inline-flex flex-wrap gap-x-1.5', className)}>
        {parts.map((part, i) => (
          <span key={i} className="whitespace-nowrap">
            {part.trim()}
            {i < parts.length - 1 ? separator : ''}
          </span>
        ))}
      </span>
    );
  }
  return <span className={cn('whitespace-nowrap', className)}>{children}</span>;
}
