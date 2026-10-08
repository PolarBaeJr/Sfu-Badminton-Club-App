'use client';

import React from 'react';
import { cn } from '../utils';
import { EmptyState } from './EmptyState';

interface Column<T> {
  key: string;
  header: string;
  render?: (row: T) => React.ReactNode;
  className?: string;
}

interface DataTableProps<T> {
  columns: Column<T>[];
  data: T[];
  keyField: string;
  onRowClick?: (row: T) => void;
  emptyMessage?: string;
}

export function DataTable<T extends Record<string, unknown>>({
  columns,
  data,
  keyField,
  onRowClick,
  emptyMessage = 'No data',
}: DataTableProps<T>) {
  if (data.length === 0) {
    return <EmptyState title={emptyMessage} />;
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full">
        <thead>
          <tr className="border-b border-[var(--border)]">
            {columns.map((col) => (
              <th key={col.key} className={cn('px-4 py-3 text-left text-[10px] font-medium text-[var(--text-muted)] uppercase tracking-[0.12em]', col.className)}>
                {col.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-[var(--border)]">
          {data.map((row) => (
            <tr
              key={String(row[keyField])}
              onClick={() => onRowClick?.(row)}
              className={cn('hover:bg-[var(--surface-2)] transition-colors', onRowClick && 'cursor-pointer')}
            >
              {columns.map((col) => (
                <td key={col.key} className={cn('px-4 py-3 text-sm text-[var(--text-secondary)]', col.className)}>
                  {col.render ? col.render(row) : String(row[col.key] ?? '')}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
