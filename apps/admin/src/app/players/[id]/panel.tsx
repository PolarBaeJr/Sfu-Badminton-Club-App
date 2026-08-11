import React from 'react';

/**
 * The square hairline box this screen is built out of.
 *
 * Built here rather than reached for in @badminton/ui because the shared
 * `Card` is `rounded-xl`, and the console's editorial style is radius 0 — the
 * same square-hairline language `.stat-strip`, `.danger-zone` and
 * `.dialog-group` already speak in globals.css. Changing `Card` itself would
 * restyle every page in both apps, which is not this change's business, so the
 * one screen that needs the square version carries it locally.
 *
 * Deliberately not exported app-wide: the moment a second screen wants it, it
 * belongs in the shared package as a considered change to `Card`, not as a
 * quietly-copied second card primitive.
 */
export function Panel({
  title,
  icon,
  trailing,
  padded = true,
  className,
  children,
}: {
  /** Display-font heading in the panel's head. Omit for a headless box. */
  title?: string;
  /** Small lucide glyph beside the heading. */
  icon?: React.ReactNode;
  /** Right-hand slot in the head — an editor trigger, a count, a badge. */
  trailing?: React.ReactNode;
  /**
   * Off for panels whose body is a table: `ResponsiveTable` draws its own
   * cell padding and its mobile cards divide edge to edge, so an outer inset
   * would inset the hairlines too.
   */
  padded?: boolean;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div
      className={`border border-[var(--border)] bg-[var(--bg-card)]${className ? ` ${className}` : ''}`}
    >
      {title && (
        <div className="flex items-center gap-2 border-b border-[var(--border)] px-5 py-4">
          {icon}
          <h2 className="flex-1 text-sm font-semibold tracking-tight text-[var(--text-primary)]">
            {title}
          </h2>
          {trailing}
        </div>
      )}
      <div className={padded ? 'p-5' : ''}>{children}</div>
    </div>
  );
}

/**
 * Mono uppercase micro-label, matching `.dialog-group-label` in globals.css.
 * Used for the sub-groups inside a panel that do not warrant a panel of their
 * own — the walkover/no-show list under the reliability counters.
 */
export function PanelLabel({ children }: { children: React.ReactNode }) {
  return <p className="dialog-group-label">{children}</p>;
}

/**
 * A labelled figure in a hairline-separated stack. The value is mono because
 * every value that uses this is a number or a fixed-shape identity token, and
 * the console sets those in mono so columns of them line up.
 */
export function PanelRow({
  label,
  value,
  tone,
}: {
  label: string;
  value: React.ReactNode;
  /** Red the value when it is a count of something that went wrong. */
  tone?: 'danger';
}) {
  return (
    <div className="flex items-center justify-between gap-4 py-2.5">
      <span className="text-sm text-[var(--text-secondary)]">{label}</span>
      <span
        className={`font-mono text-sm ${
          tone === 'danger' ? 'text-[var(--color-danger)]' : 'text-[var(--text-primary)]'
        }`}
      >
        {value}
      </span>
    </div>
  );
}
