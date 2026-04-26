import React from 'react';

interface PageHeaderProps {
  /** Mono red eyebrow text. The leading bar is rendered automatically. */
  eyebrow?: string;
  /** Space Grotesk display title. */
  title: string;
  /** Optional sub-line under the title. */
  sub?: React.ReactNode;
  /** Right-side actions (buttons, search, etc.). */
  actions?: React.ReactNode;
}

export function PageHeader({ eyebrow, title, sub, actions }: PageHeaderProps) {
  return (
    <div className="page-header">
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
