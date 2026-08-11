import React from 'react';

interface SectionProps {
  /** Section title (Space Grotesk). */
  title: string;
  /** Optional sub-line under the title. */
  sub?: React.ReactNode;
  /** Right-side adornment in the section head — typically a tag or count. */
  trailing?: React.ReactNode;
  /** Tighten the inner padding (e.g. for table-style sections). */
  flush?: boolean;
  /** Stack children with a 10px gap; turn off for grids/tables. */
  stack?: boolean;
  /** Anchor id on the card itself — a section rail links to these. Without it
   *  callers had to wrap the Section in an otherwise pointless <div id>. */
  id?: string;
  className?: string;
  children: React.ReactNode;
}

/** Card-base wrapper with a redesign card-head — used for /feed sidebar
 * cards, /challenges sections, /settings groups, etc. */
export function Section({ title, sub, trailing, flush, stack = true, id, className, children }: SectionProps) {
  return (
    <div id={id} className={'card-base' + (flush ? '' : '') + (className ? ' ' + className : '')} style={flush ? { padding: 0, overflow: 'hidden' } : undefined}>
      <div
        className="card-head"
        style={flush ? { padding: '20px 20px 14px', borderBottom: '1px solid var(--line)', marginBottom: 0 } : undefined}
      >
        <div>
          <h3 className="card-title">{title}</h3>
          {sub && <div className="card-sub">{sub}</div>}
        </div>
        {trailing}
      </div>
      {stack ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>{children}</div>
      ) : (
        children
      )}
    </div>
  );
}
