import React from 'react';

/**
 * The label row that sits at the top of every panel on /seasons.
 *
 * Built here rather than reached for, for the same reason /fees has its own
 * `CardHeading`: @badminton/ui ships `Section`, which brings its own surface
 * with it, and putting one inside a `Card` would nest two cards — the one thing
 * the console's guidance rules out by name. This is the head without the box.
 *
 * The right-hand `note` is the column's own caption ("NEWEST FIRST"), not an
 * action. It is deliberately quieter than the label so the pair reads as one
 * line rather than as two competing headings.
 */

/** Micro-label type. Shared so a panel that cannot use the component matches it. */
export const PANEL_LABEL =
  'font-mono text-[10px] font-medium uppercase tracking-[0.16em] text-[var(--text-muted)]';

/**
 * The mockup's second text tone, `--dim`, has no token in this console —
 * globals.css defines --ink / --ink-2 / --mute and stops. Rather than invent a
 * colour value (the guidance forbids it) the fainter tier is expressed as the
 * SAME token at a smaller size and wider tracking, which is what actually
 * separates the two tiers on screen.
 */
export const PANEL_NOTE =
  'font-mono text-[10px] font-medium uppercase tracking-[0.12em] text-[var(--text-muted)]';

export function PanelLabel({
  label,
  note,
  className,
}: {
  label: string;
  /** Right-aligned caption — "NEWEST FIRST", "OF 17 · CLOSES 4 MAY". */
  note?: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={`flex items-baseline justify-between gap-3 ${className ?? ''}`}>
      <span className={PANEL_LABEL}>{label}</span>
      {note && <span className={PANEL_NOTE}>{note}</span>}
    </div>
  );
}
