import * as React from 'react';

export function DPageHead({
  eyebrow,
  title,
  meta,
  actions,
}: {
  eyebrow?: string;
  title: string;
  meta?: React.ReactNode;
  actions?: React.ReactNode;
}) {
  return (
    <div className="d-page-head">
      <div>
        {eyebrow ? (
          <div className="d-tag-row">
            <span className="d-red-line" />
            <span className="d-micro d-micro-red">{eyebrow}</span>
          </div>
        ) : null}
        <h2>{title}</h2>
        {meta ? <p className="d-meta">{meta}</p> : null}
      </div>
      {actions ? <div className="d-page-head-actions">{actions}</div> : null}
    </div>
  );
}

export function DStat({
  label,
  value,
  delta,
  deltaTone,
  red,
}: {
  label: string;
  value: React.ReactNode;
  delta?: string;
  deltaTone?: 'up' | 'down' | 'neutral';
  red?: boolean;
}) {
  return (
    <div className="d-stat">
      <div className="d-stat-label">{label}</div>
      <div className={`d-stat-num${red ? ' d-stat-red' : ''}`}>{value}</div>
      {delta ? (
        <div
          className={`d-stat-delta${deltaTone === 'up' ? ' d-up' : deltaTone === 'down' ? ' d-down' : ''}`}
        >
          {delta}
        </div>
      ) : null}
    </div>
  );
}

export function DPanel({
  label,
  sublabel,
  action,
  children,
}: {
  label: string;
  sublabel?: string;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="d-panel">
      <div className="d-panel-head">
        <div className="d-label">
          {label}
          {sublabel ? (
            <span style={{ color: 'var(--text-faint)', fontWeight: 500, marginLeft: 8 }}>
              {sublabel}
            </span>
          ) : null}
        </div>
        {action ? action : null}
      </div>
      {children}
    </div>
  );
}
