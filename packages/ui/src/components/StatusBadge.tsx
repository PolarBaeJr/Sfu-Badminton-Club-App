import * as React from 'react';
import { cn } from '../utils';

export type StatusType =
  | 'active'
  | 'pending'
  | 'suspended'
  | 'confirmed'
  | 'attended'
  | 'resolved'
  | 'completed'
  | 'open'
  | 'full'
  | 'review'
  | 'disputed'
  | 'draft';

const styles: Record<StatusType, React.CSSProperties> = {
  active:    { background: 'rgba(74,222,128,0.08)',  color: 'var(--green)', border: '1px solid rgba(74,222,128,0.18)' },
  confirmed: { background: 'rgba(74,222,128,0.08)',  color: 'var(--green)', border: '1px solid rgba(74,222,128,0.18)' },
  attended:  { background: 'rgba(74,222,128,0.08)',  color: 'var(--green)', border: '1px solid rgba(74,222,128,0.18)' },
  pending:   { background: 'rgba(251,191,36,0.08)',  color: 'var(--amber)', border: '1px solid rgba(251,191,36,0.18)' },
  suspended: { background: 'rgba(204,0,0,0.10)',     color: 'var(--red)',   border: '1px solid rgba(204,0,0,0.22)'   },
  full:      { background: 'rgba(204,0,0,0.10)',     color: 'var(--red)',   border: '1px solid rgba(204,0,0,0.22)'   },
  review:    { background: 'rgba(204,0,0,0.10)',     color: 'var(--red)',   border: '1px solid rgba(204,0,0,0.22)'   },
  disputed:  { background: 'rgba(204,0,0,0.10)',     color: 'var(--red)',   border: '1px solid rgba(204,0,0,0.22)'   },
  resolved:  { background: 'rgba(255,255,255,0.05)', color: 'var(--muted)', border: '1px solid var(--hairline)'      },
  completed: { background: 'rgba(255,255,255,0.05)', color: 'var(--muted)', border: '1px solid var(--hairline)'      },
  open:      { background: 'rgba(255,255,255,0.05)', color: 'var(--ink)',   border: '1px solid var(--hairline-strong)' },
  draft:     { background: 'rgba(255,255,255,0.05)', color: 'var(--muted)', border: '1px solid var(--hairline)'      },
};

export interface StatusBadgeProps extends Omit<React.HTMLAttributes<HTMLSpanElement>, 'children'> {
  status: StatusType;
  label?: string;
}

export function StatusBadge({ status, label, className, style, ...rest }: StatusBadgeProps) {
  return (
    <span
      className={cn(
        'inline-block uppercase font-bold leading-tight rounded-none',
        'text-[9px] tracking-[0.15em] px-2 py-[3px]',
        className,
      )}
      style={{ ...styles[status], ...style }}
      {...rest}
    >
      {label ?? status}
    </span>
  );
}
