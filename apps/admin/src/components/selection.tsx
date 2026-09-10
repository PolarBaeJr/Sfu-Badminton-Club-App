'use client';

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { Checkbox } from '@badminton/ui';
import {
  resolveSelection,
  setAllVisibleSelected,
  toggleSelected,
  type SelectableItem,
} from '@/lib/selection-model';

export type { SelectableItem };

/**
 * Picking several rows out of a table, so one decision can be applied to all of
 * them.
 *
 * WHY A CONTEXT AND NOT A PROP. Both tables that need this — the roster and the
 * sessions list — build their rows on the SERVER: `<tr>` and `<TableCard>`
 * arrive at the client component already rendered, with the Elo arithmetic, the
 * waiver maths and the capability-gated action buttons baked in. A client
 * component cannot reach into a finished ReactNode to add a cell. What it CAN
 * do is render that node inside a provider, and have the small client checkbox
 * the server placed in the row read the context from the position it lands in.
 * That is the whole mechanism, and it is why the checkbox is a component rather
 * than a prop the table passes down.
 *
 * THE SELECTION IS KEYED BY ID AND NOTHING ELSE — never derived from which
 * checkboxes are mounted. The roster windows its rows 25 at a time, so a
 * selection that lived in the checkboxes would silently empty itself as the
 * officer scrolled past row 25.
 *
 * WHAT IS SELECTED SURVIVES A SEARCH, ON PURPOSE. Type "chen", tick three,
 * clear the search, type "wong", tick two: five people are selected and the bar
 * says so. That is the thing that makes a 500-row roster workable, and it is
 * also the thing that could get somebody banned who the officer never had on
 * screen. Two guards, both of them here rather than in each caller:
 *
 *   * SelectionBar names, out loud, how many of the selection the current
 *     filter is hiding — the same honesty the roster's "showing X of Y · Z in
 *     tab" line owes the reader;
 *   * `selectedItems` carries the LABELS as well as the ids, so every bulk
 *     confirmation can list the people it is about to act on by name. A dialog
 *     that says "40 members" is a number; one that says who they are is a
 *     decision.
 */

interface SelectionValue {
  selectedIds: ReadonlySet<string>;
  /**
   * The selected rows, IN PAGE ORDER, and only the ones the page still has.
   *
   * Derived from `items` rather than read off the Set, which is what makes a
   * stale id harmless: after a bulk archive the page revalidates, the archived
   * sessions leave the list, and anything still ticked that no longer exists
   * stops being counted and stops being acted on — without an effect racing the
   * re-render to prune it.
   */
  selectedItems: SelectableItem[];
  /** Selected rows the current search or tab is NOT showing. */
  hiddenCount: number;
  isSelected: (id: string) => boolean;
  toggle: (id: string) => void;
  /** Adds every visible row, or removes every visible row. Never touches a
   *  selected row the filter is hiding — taking away what somebody cannot see
   *  is the same failure as acting on it. */
  setAllVisible: (checked: boolean) => void;
  clear: () => void;
  /** All visible rows are selected. */
  allVisibleSelected: boolean;
  /** Some but not all — the select-all box's "mixed" state. */
  someVisibleSelected: boolean;
}

const SelectionContext = createContext<SelectionValue | null>(null);

export function useSelection(): SelectionValue {
  const value = useContext(SelectionContext);
  if (!value) {
    throw new Error('useSelection must be used inside a <SelectionProvider>');
  }
  return value;
}

export function SelectionProvider({
  items,
  visibleIds,
  children,
}: {
  /** Every row the page fetched, selectable or not, in the order it renders. */
  items: SelectableItem[];
  /**
   * The subset a search or a window is currently showing. Separate from
   * `items` because select-all must mean "everything the filter matched" and
   * never "everything in the tab" — the roster's list query is capped at 500
   * and the tab count is not, so the two genuinely differ.
   */
  visibleIds: readonly string[];
  children: ReactNode;
}) {
  const [selectedIds, setSelectedIds] = useState<ReadonlySet<string>>(() => new Set());

  const visible = useMemo(() => new Set(visibleIds), [visibleIds]);

  // EVERY RULE COMES FROM lib/selection-model.ts and none of them is restated
  // here. This component owns the useState and nothing else, which is what lets
  // the rules be tested at all — the console's suite runs with no DOM.
  const resolved = useMemo(
    () => resolveSelection(items, selectedIds, visible),
    [items, selectedIds, visible],
  );

  const toggle = useCallback((id: string) => {
    setSelectedIds((prev) => toggleSelected(prev, id));
  }, []);

  const setAllVisible = useCallback(
    (checked: boolean) => {
      setSelectedIds((prev) => setAllVisibleSelected(prev, visible, checked));
    },
    [visible],
  );

  const clear = useCallback(() => setSelectedIds(new Set()), []);

  const value = useMemo<SelectionValue>(
    () => ({
      selectedIds,
      ...resolved,
      isSelected: (id) => selectedIds.has(id),
      toggle,
      setAllVisible,
      clear,
    }),
    [selectedIds, resolved, toggle, setAllVisible, clear],
  );

  return <SelectionContext.Provider value={value}>{children}</SelectionContext.Provider>;
}

/**
 * The checkbox in one row.
 *
 * Rendered by the SERVER, inside the `<tr>` and the `<TableCard>` — see the note
 * at the top of this file. RowLink's INTERACTIVE list already covers `input` and
 * `label`, so ticking a box in the roster does not also open that member's page.
 */
export function RowSelectCheckbox({ id, label }: { id: string; label: string }) {
  const { isSelected, toggle } = useSelection();
  return (
    <Checkbox
      checked={isSelected(id)}
      onChange={() => toggle(id)}
      label={`Select ${label}`}
    />
  );
}

/** The checkbox in the header cell. "All" means everything the filter matched,
 *  which is not everything the tab holds — see SelectionProvider. */
export function SelectAllCheckbox({ noun = 'row' }: { noun?: string }) {
  const { allVisibleSelected, someVisibleSelected, setAllVisible } = useSelection();
  return (
    <Checkbox
      checked={allVisibleSelected}
      indeterminate={someVisibleSelected}
      onChange={setAllVisible}
      label={allVisibleSelected ? `Clear every shown ${noun}` : `Select every shown ${noun}`}
    />
  );
}

/**
 * The bar that appears once something is ticked, holding whatever the page can
 * do to a selection.
 *
 * Sticky to the bottom of the viewport rather than sat above the table: on a
 * 500-row roster the officer ticking row 180 would otherwise have to scroll back
 * to the top to act, and would lose sight of what they had chosen on the way.
 *
 * THE HIDDEN COUNT IS PRINTED, NOT SWALLOWED. A selection that outlives a
 * search is the useful behaviour; a count that reads as "the twelve I can see"
 * when four of them are behind a filter is how somebody acts on a person they
 * never looked at.
 */
export function SelectionBar({ noun, children }: { noun: string; children: ReactNode }) {
  const { selectedItems, hiddenCount, clear } = useSelection();
  if (selectedItems.length === 0) return null;

  const plural = selectedItems.length === 1 ? noun : `${noun}s`;

  return (
    <div className="sticky bottom-0 z-20 -mx-1 px-1 pb-1">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border border-[var(--color-accent)] bg-[var(--bg-secondary)] px-4 py-3 shadow-lg">
        <span className="font-mono text-[11px] uppercase tracking-[0.14em] text-[var(--text-primary)]">
          {selectedItems.length} {plural} selected
          {hiddenCount > 0 && (
            <span className="ml-2 normal-case tracking-normal text-[var(--color-warning)]">
              ({hiddenCount} not shown by the current filter)
            </span>
          )}
        </span>
        <div className="ml-auto flex flex-wrap items-center gap-2 [&_button]:min-h-[44px]">
          {children}
          <button
            type="button"
            onClick={clear}
            className="min-h-[44px] px-2 font-mono text-[10px] uppercase tracking-[0.14em] text-[var(--text-muted)] transition-colors hover:text-[var(--text-primary)]"
          >
            Clear
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * The people (or nights) a bulk confirmation is about, named.
 *
 * EVERY BULK DIALOG SHOWS THIS, and it is the real answer to the hazard the
 * persistent selection creates. A selection can outlive the search that built
 * it, so "40 members" on a confirm button is a number an officer cannot check.
 * A list they can read — and scroll — is one they can.
 *
 * Capped in HEIGHT, never in content: a long selection scrolls inside the box
 * rather than being truncated to "and 34 others", because the truncated ones are
 * precisely the ones nobody would have noticed.
 */
export function SelectionSummary({ noun }: { noun: string }) {
  const { selectedItems } = useSelection();
  return (
    <div>
      <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-[var(--text-muted)]">
        {selectedItems.length} {selectedItems.length === 1 ? noun : `${noun}s`}
      </p>
      <ul className="mt-1.5 max-h-40 overflow-y-auto border border-[var(--border)] px-3 py-2 text-sm text-[var(--text-secondary)]">
        {selectedItems.map((i) => (
          <li key={i.id} className="py-0.5 [overflow-wrap:anywhere]">
            {i.label}
          </li>
        ))}
      </ul>
    </div>
  );
}
