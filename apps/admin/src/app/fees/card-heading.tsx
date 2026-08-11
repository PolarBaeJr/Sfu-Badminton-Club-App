import React from 'react';

/**
 * The heading row inside a content card on the money page.
 *
 * Built here rather than reached for: @badminton/ui ships `Section`, which is
 * the right shape but brings its own `card-base` surface with it, so putting one
 * inside a `Card` would nest two cards — the one thing the console's design
 * guidance rules out by name. This is the head without the box.
 *
 * The four panels on /fees each grew their own heading markup, at three
 * different sizes and two different weights, none of them the console's section
 * type. Section labels here are condensed display caps; body-weight sentence
 * case is what a card's CONTENT looks like, and a heading that matches its own
 * rows stops working as a heading.
 */

/** Shared so a panel that cannot use the component still matches it. */
export const SECTION_HEADING =
  'font-display text-base font-bold uppercase tracking-[0.06em] leading-none text-[var(--text-primary)]';

export function CardHeading({
  title,
  sub,
  action,
}: {
  title: string;
  sub?: React.ReactNode;
  /** Right-aligned control — the ledger Add buttons sit here. */
  action?: React.ReactNode;
}) {
  return (
    <div className="px-4 pt-4 flex items-start justify-between gap-4">
      <div className="min-w-0">
        <h2 className={SECTION_HEADING}>{title}</h2>
        {sub && <p className="text-xs text-[var(--text-muted)] mt-1.5">{sub}</p>}
      </div>
      {action}
    </div>
  );
}
