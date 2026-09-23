'use client';

import { Fragment, useMemo, useState, type ReactNode } from 'react';
import { Card, ResponsiveTable, SearchFilter, filterRowsByPlayers } from '@badminton/ui';
import { SelectionProvider, type SelectableItem } from '@/components/selection';

export interface FeeTableRow {
  id: string;
  /** The name the search matches: the member's, or a manual entry's. */
  name: string;
  /** Matched too, so an admin can paste the address off an e-transfer. */
  email?: string | null;
  /**
   * Whether this row carries a checkbox. Manual entries do not, and
   * `visibleIds` must agree with which rows actually have one, or
   * SelectAllCheckbox ticks rows that show no box.
   */
  selectable: boolean;
  /** The `<tr>`, rendered on the server. */
  row: ReactNode;
  /** The `<TableCard>` shown below `md`, rendered on the server. */
  card: ReactNode;
}

/**
 * The Club fees table with a search over it, and the selection it feeds.
 *
 * THE PROVIDER LIVES HERE rather than in the page because select-all has to
 * mean "every member the search is showing", and only this component knows
 * which those are. `items` stays the whole fee list, so a member ticked before
 * the search hid them is still counted as hidden rather than dropped.
 *
 * Client-side over rows the page already fetched, the same trade
 * SearchableTable makes: no round trip per keystroke.
 */
export function FeeTable({
  items,
  rows,
  head,
  heading,
  empty,
  after,
}: {
  items: SelectableItem[];
  rows: FeeTableRow[];
  /** The `<tr>` of `<th>`s. */
  head: ReactNode;
  /** The card's heading, above the search. */
  heading: ReactNode;
  /** Shown instead of the table when there is nothing to list at all. */
  empty: ReactNode;
  /** Rendered inside the provider after the card: the bulk action bar. */
  after?: ReactNode;
}) {
  const [query, setQuery] = useState('');
  const searchable = useMemo(
    () => rows.map((r) => ({ ...r, players: [r.name], meta: r.email ?? null })),
    [rows],
  );
  const visible = useMemo(() => filterRowsByPlayers(searchable, query), [searchable, query]);
  const visibleIds = useMemo(
    () => visible.filter((r) => r.selectable).map((r) => r.id),
    [visible],
  );

  return (
    <SelectionProvider items={items} visibleIds={visibleIds}>
      <Card padding={false}>
        {heading}
        {rows.length === 0 ? (
          empty
        ) : (
          <>
            {/* Outside the branch below: a query that matches nothing must not
                take the field with it, or there is no way to undo it. */}
            <div className="p-3 border-b border-[var(--border)]">
              <SearchFilter
                value={query}
                onChange={setQuery}
                label="Search fees by member name or email"
                placeholder="Search by name or email"
                resultCount={visible.length}
                noun="entry"
                nounPlural="entries"
              />
            </div>
            {visible.length === 0 ? (
              <p className="py-8 px-4 text-center text-[var(--text-muted)] [overflow-wrap:anywhere]">
                No entries match “{query}”
              </p>
            ) : (
              <ResponsiveTable cards={visible.map((r) => <Fragment key={r.id}>{r.card}</Fragment>)}>
                <table className="w-full">
                  <thead>{head}</thead>
                  <tbody className="divide-y divide-[var(--border)]">
                    {visible.map((r) => (
                      <Fragment key={r.id}>{r.row}</Fragment>
                    ))}
                  </tbody>
                </table>
              </ResponsiveTable>
            )}
          </>
        )}
      </Card>
      {after}
    </SelectionProvider>
  );
}
