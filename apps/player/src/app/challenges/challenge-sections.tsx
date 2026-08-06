'use client';

import { Fragment, useMemo, useState, type ReactNode } from 'react';
import { SearchFilter, filterRowsByPlayers } from '@badminton/ui';

export interface ChallengeItem {
  id: string;
  /**
   * Everyone named on the challenge — you, your partner, your opponents and
   * whoever issued it. The search key, not the display: the card has already
   * rendered these names into "X challenged you · vs Y & Z".
   */
  players: string[];
  /** The card, rendered on the SERVER — it needs the viewer's own id to work
   *  out which side is "you", and none of that needs to reach the browser. */
  card: ReactNode;
}

export interface ChallengeSection {
  title: string;
  items: ChallengeItem[];
}

/**
 * The challenge feed, with the same search the roster and the admin lists use.
 *
 * ONE box over all four sections, not one each. Incoming / Active / Yours /
 * Archived are facets of a single small set — the viewer's own challenges — and
 * "what did I play against Chen" is a question about all of them at once.
 * Four fields stacked down a phone would also be four times the chrome for a
 * list that is often shorter than the controls above it.
 *
 * Unlike the roster's tabs there is nothing to leak between: every section is
 * on screen simultaneously, so there is no hidden pane holding a stale query
 * and no `key={tab}` remount to force.
 */
export function ChallengeSections({ sections }: { sections: ChallengeSection[] }) {
  const [query, setQuery] = useState('');

  const filtered = useMemo(
    () => sections.map((s) => ({ ...s, items: filterRowsByPlayers(s.items, query) })),
    [sections, query],
  );
  const total = filtered.reduce((n, s) => n + s.items.length, 0);

  return (
    <div className="feed-col">
      <SearchFilter
        value={query}
        onChange={setQuery}
        label="Search challenges by player"
        // Every section at once, and either side of the net — say so, because
        // "Search" alone would leave you guessing whether Archived is included.
        placeholder="Search by any player…"
        resultCount={total}
        noun="challenge"
      />

      {total === 0 ? (
        // Every section is empty at once. Without this the page would simply
        // go blank — each section renders only when it has rows — leaving no
        // sign that a query is what emptied it.
        <div className="card-base">
          <div className="empty" style={{ overflowWrap: 'anywhere' }}>
            No challenges match “{query}”
          </div>
        </div>
      ) : (
        filtered.map((s) =>
          s.items.length === 0 ? null : (
            <div className="card-base" key={s.title}>
              <div className="card-head">
                <h3 className="card-title">{s.title}</h3>
                {/* The filtered count, not the total: a section that says 6
                    while showing 2 is a section arguing with itself. */}
                <span className="tag">{s.items.length}</span>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                {s.items.map((it) => (
                  <Fragment key={it.id}>{it.card}</Fragment>
                ))}
              </div>
            </div>
          )
        )
      )}
    </div>
  );
}
