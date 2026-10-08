import React from 'react';

interface DataRowProps {
  /** Slot at the left — usually an avatar or icon. */
  leading?: React.ReactNode;
  /** Primary line. */
  title: React.ReactNode;
  /** Optional sub-line in muted mono. */
  sub?: React.ReactNode;
  /** Slot at the right — tags, action button, chevron, etc. */
  trailing?: React.ReactNode;
  /** Wrap in an <a>/<Link> via this href. */
  href?: string;
  /** Visually mute the row (used for read notifications, archived items). */
  dim?: boolean;
  /** Add a red left-border accent (used for unread). */
  accent?: boolean;
  className?: string;
  onClick?: () => void;
}

/** A single horizontal row inside a Section. Used by /challenges,
 * /notifications, /my-stats partner list, /tournaments registration list. */
export function DataRow({
  leading,
  title,
  sub,
  trailing,
  href,
  dim,
  accent,
  className,
  onClick,
}: DataRowProps) {
  const style: React.CSSProperties = {
    display: 'flex',
    gap: 12,
    alignItems: 'center',
    padding: '12px 14px',
    border: '1px solid var(--line)',
    borderRadius: 10,
    background: 'var(--surface)',
    opacity: dim ? 0.65 : 1,
    borderLeft: accent ? '3px solid var(--red)' : undefined,
    cursor: href || onClick ? 'pointer' : undefined,
    textDecoration: 'none',
    color: 'inherit',
  };
  const content = (
    <>
      {leading}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontWeight: 600, fontSize: 14, lineHeight: 1.3 }}>{title}</div>
        {sub && (
          <div className="mono muted" style={{ fontSize: 11, marginTop: 2 }}>
            {sub}
          </div>
        )}
      </div>
      {trailing}
    </>
  );
  if (href) {
    return (
      <a href={href} style={style} className={'press' + (className ? ' ' + className : '')}>
        {content}
      </a>
    );
  }
  return (
    <div onClick={onClick} style={style} className={(onClick ? 'press' : '') + (className ? ' ' + className : '')}>
      {content}
    </div>
  );
}
