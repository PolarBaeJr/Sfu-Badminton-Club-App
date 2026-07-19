import React from 'react';
import { cn } from '../utils';

interface PageHeaderProps {
  /** Mono red eyebrow text. The leading bar is rendered automatically. */
  eyebrow?: string;
  /** Space Grotesk display title. */
  title: string;
  /** Optional sub-line under the title. */
  sub?: React.ReactNode;
  /** Right-side actions (buttons, search, etc.). */
  actions?: React.ReactNode;
  /** Extra classes merged onto the root element (e.g. reveal stagger). */
  className?: string;
}

export function PageHeader({ eyebrow, title, sub, actions, className }: PageHeaderProps) {
  return (
    <div className={cn('page-header', className)}>
      <div>
        {eyebrow && (
          <div className="page-eyebrow">
            <span className="bar" />
            {eyebrow}
          </div>
        )}
        <h1 className="page-title">{title}</h1>
        {sub && <div className="page-sub">{sub}</div>}
      </div>
      {actions && (
        <div className="row" style={{ gap: 10 }}>
          {actions}
        </div>
      )}
    </div>
  );
}
