'use client';

import { Fragment, useMemo, useState, type ReactNode } from 'react';
import { ChevronRight } from 'lucide-react';
import { SearchFilter, filterRowsByPlayers } from '@badminton/ui';

export interface ChallengeItem {
  id: string;
  /**
   * Everyone named on the challenge: you, your partner, your opponents and
   * whoever issued it, by name AND handle. The search key, not the display:
   * the row shows names only, so "@kiera" matches here without being drawn.
   */
  players: string[];
  /** The row, rendered on the SERVER. It needs the viewer's own id to work
   *  out which side is "you", and none of that needs to reach the browser. */
  card: ReactNode;
}

export interface ChallengeSection {
  title: string;
  items: ChallengeItem[];
  /** The section that is a question for the reader: drawn with the red edge. */
  accent?: boolean;
}

/**
 * Past this many listed rows the search box appears. Below it the whole list
 * fits on a screen and the box is chrome for a question the eye answers
 * faster. Counts rows as listed, so a challenge in both Active and Your
 * challenges counts twice, the way it is drawn.
 */
export const SEARCH_THRESHOLD = 8;

function SectionList({ items }: { items: ChallengeItem[] }) {
  return (
    <div className="chal-list">
      {items.map((it) => (
        <Fragment key={it.id}>{it.card}</Fragment>
      ))}
    </div>
  );
}

/**
 * The challenge feed: the live sections as cards, then Archived behind a
 * disclosure.
 *
 * ONE search box over every section, not one each. Incoming / Active / Yours /
 * Archived are facets of a single small set (the viewer's own challenges), and
 * "what did I play against Chen" is a question about all of them at once. It
 * is only drawn once the list is long enough to need it; see SEARCH_THRESHOLD.
 *
 * Archived starts CLOSED, always, including when nothing is live: then `empty`
 * sits above it and is the thing the page should be about. Typing a query
 * opens it, so a match that only exists in the archive is not hidden behind a
 * collapsed summary.
 */
export function ChallengeSections({
  sections,
  archived,
  empty,
}: {
  sections: ChallengeSection[];
  archived: ChallengeItem[];
  /** Shown when no live section has a row, above the archive. */
  empty: ReactNode;
}) {
  const [query, setQuery] = useState('');
  const [archiveOpen, setArchiveOpen] = useState(false);

  const liveCount = sections.reduce((n, s) => n + s.items.length, 0);
  const listed = liveCount + archived.length;

  const filtered = useMemo(
    () => sections.map((s) => ({ ...s, items: filterRowsByPlayers(s.items, query) })),
    [sections, query],
  );
  const filteredArchive = useMemo(() => filterRowsByPlayers(archived, query), [archived, query]);
  const total = filtered.reduce((n, s) => n + s.items.length, 0) + filteredArchive.length;

  return (
    <div className="feed-col">
      {listed > SEARCH_THRESHOLD && (
        <SearchFilter
          className="chal-search"
          value={query}
          onChange={(next) => {
            setQuery(next);
            if (next.trim()) setArchiveOpen(true);
          }}
          label="Search challenges by player"
          // Every section at once, and either side of the net. Say so, because
          // "Search" alone would leave you guessing whether Archived is included.
          placeholder="Search by any player…"
          resultCount={total}
          noun="challenge"
        />
      )}

      {query && total === 0 ? (
        // Every section is empty at once. Without this the page would simply
        // go blank (each section renders only when it has rows), leaving no
        // sign that a query is what emptied it.
        <div className="card-base">
          <div className="empty" style={{ overflowWrap: 'anywhere' }}>
            No challenges match “{query}”
          </div>
        </div>
      ) : (
        <>
          {liveCount === 0 && empty}

          {filtered.map((s) =>
            s.items.length === 0 ? null : (
              <section className="chal-section" data-accent={s.accent || undefined} key={s.title}>
                <div className="chal-section-head">
                  <h3 className="card-title">{s.title}</h3>
                  {/* The filtered count, not the total: a section that says 6
                      while showing 2 is a section arguing with itself. */}
                  <span className={s.accent ? 'tag tag-red' : 'tag'}>{s.items.length}</span>
                </div>
                <SectionList items={s.items} />
              </section>
            )
          )}

          {filteredArchive.length > 0 && (
            <details
              className="chal-archive"
              open={archiveOpen}
              onToggle={(e) => setArchiveOpen(e.currentTarget.open)}
            >
              <summary className="chal-archive-head">
                <ChevronRight size={16} className="chal-archive-chevron" aria-hidden="true" />
                <span className="chal-archive-title">Archived</span>
                <span className="tag">{filteredArchive.length}</span>
              </summary>
              <SectionList items={filteredArchive} />
            </details>
          )}
        </>
      )}
    </div>
  );
}
