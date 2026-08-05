'use client';

import { useId, useMemo, useState } from 'react';
import { AvatarChip } from '@badminton/ui';
import { Crown, Search, Users } from 'lucide-react';

// The page is a server component; only the fields this card renders cross the
// boundary, so a schema change to tournament_participants cannot silently
// enlarge the client payload.
export interface ParticipantEntry {
  id: string;
  name: string;
  seed: number | null;
  status: string;
  finalPosition: number | null;
  /** One avatar for a singles entry, two for a pair. */
  avatars: Array<{ name: string; url: string | null }>;
}

// Mirrors the admin ParticipantsTab map — raw enum values ("no_show") read as
// database internals. Only the states that take someone OUT of the event get a
// chip: badging every row "Registered" would be noise on the common case.
const OUT_STATUS_LABELS: Record<string, string> = {
  withdrawn: 'Withdrawn',
  disqualified: 'Disqualified',
  no_show: 'No Show',
};

const OUT_STATUS_CHIP: Record<string, string> = {
  withdrawn: '',
  disqualified: 'chip-red',
  no_show: 'chip-warning',
};

export function ParticipantsList({
  entries,
  doubles,
}: {
  entries: ParticipantEntry[];
  doubles: boolean;
}) {
  const [query, setQuery] = useState('');
  const inputId = useId();

  const plural   = doubles ? 'pairs' : 'participants';
  const singular = doubles ? 'pair'  : 'participant';
  const trimmed  = query.trim();
  const needle   = trimmed.toLowerCase();

  // A pair's name is "A & B", so a substring match finds either member.
  const filtered = useMemo(
    () => (needle ? entries.filter((e) => e.name.toLowerCase().includes(needle)) : entries),
    [entries, needle]
  );

  const total = entries.length;
  const summary = needle
    ? `${filtered.length} of ${total} ${filtered.length === 1 ? singular : plural} matching "${trimmed}"`
    : `${total} ${total === 1 ? singular : plural}`;

  return (
    <div className="card-surface rounded-2xl overflow-hidden">
      <div className="p-4 pb-3">
        <div className="flex items-center gap-2">
          <Users className="w-4 h-4 text-[var(--text-muted)]" />
          <h2 className="display-md">{doubles ? 'Pairs' : 'Participants'}</h2>
        </div>

        {total > 0 && (
          <>
            <label htmlFor={inputId} className="sr-only">
              Search {plural} by name
            </label>
            {/* Own row rather than inline with the title: at 375px a fixed-width
                field beside the heading leaves room for about two characters. */}
            <div className="search-pill mt-3 min-h-[44px]">
              <Search className="w-3.5 h-3.5 text-[var(--text-muted)] shrink-0" aria-hidden />
              <input
                id={inputId}
                type="search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search by name..."
                autoComplete="off"
                className="flex-1 min-w-0 text-[var(--text-primary)]"
              />
            </div>
            {/* Mounted on first render, not conditionally on a query: a live
                region created at the same moment as its text is not announced. */}
            <p role="status" aria-live="polite" className="text-xs text-[var(--text-muted)] mt-2">
              {summary}
            </p>
          </>
        )}
      </div>

      <div className="px-4 pb-4 space-y-2">
        {total === 0 ? (
          <p className="text-[var(--text-muted)] text-sm text-center py-6">No {plural} yet</p>
        ) : filtered.length === 0 ? (
          <p className="text-[var(--text-muted)] text-sm text-center py-6">
            No {plural} match &ldquo;{trimmed}&rdquo;
          </p>
        ) : (
          filtered.map((entry, i) => {
            // Stagger the entrance only on the unfiltered list. Rows are keyed
            // by id, so React reuses the nodes and re-running the reveal
            // animation on every keystroke flickers the list while typing.
            const reveal   = needle ? '' : `reveal ${i < 3 ? `reveal-${i + 1}` : ''}`;
            const outLabel = OUT_STATUS_LABELS[entry.status];

            return (
              <div
                key={entry.id}
                className={`${reveal} flex items-center justify-between p-2.5 bg-[var(--on-surface-soft)] rounded-xl border border-[var(--border)] gap-2`}
              >
                <div className="flex items-center gap-2.5 min-w-0">
                  {entry.seed && (
                    <span className="nums text-xs text-[var(--text-muted)] w-5 text-center shrink-0">
                      #{entry.seed}
                    </span>
                  )}
                  <div className="flex -space-x-2 shrink-0">
                    {entry.avatars.map((a, ai) => (
                      <AvatarChip key={ai} name={a.name} src={a.url} size="sm" />
                    ))}
                  </div>
                  <span className="text-sm text-[var(--text-primary)] font-medium truncate">
                    {entry.name}
                  </span>
                </div>
                <div className="flex items-center gap-1.5 shrink-0">
                  {entry.finalPosition === 1 && (
                    <Crown className="w-3.5 h-3.5 text-[var(--color-gold)]" aria-hidden />
                  )}
                  {entry.finalPosition && (
                    <span className={`chip ${entry.finalPosition === 1 ? 'chip-gold' : ''}`}>
                      <span className="sr-only">Position </span>#{entry.finalPosition}
                    </span>
                  )}
                  {outLabel && (
                    <span className={`chip ${OUT_STATUS_CHIP[entry.status] ?? ''}`}>{outLabel}</span>
                  )}
                </div>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
