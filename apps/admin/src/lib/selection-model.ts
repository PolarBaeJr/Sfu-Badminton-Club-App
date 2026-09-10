// The arithmetic of "which of these rows are chosen", with no React in it.
//
// A PLAIN MODULE ON PURPOSE. The provider that uses this (components/selection.tsx)
// is a client component holding a useState, and the console's test setup runs in
// `environment: 'node'` with no DOM — so a rule that lived inside the component
// could not be tested at all. The rules here are the ones that are dangerous to
// get wrong:
//
//   * a selection must survive a row being unmounted, because the roster keeps
//     only 25 of up to 500 rows in the DOM and scrolling past one must not
//     un-choose the member;
//   * "select all" must mean the rows the current search MATCHED, which is
//     neither the rows on screen nor everything in the tab;
//   * a chosen row the current filter is hiding must stay chosen AND be counted
//     out loud, because acting on somebody an officer cannot see is the failure
//     this whole feature could cause.

export interface SelectableItem {
  id: string;
  /** What a confirmation dialog should call this row. A name, a session title. */
  label: string;
}

/** Add if absent, remove if present. */
export function toggleSelected(selected: ReadonlySet<string>, id: string): Set<string> {
  const next = new Set(selected);
  if (!next.delete(id)) next.add(id);
  return next;
}

/**
 * Tick, or untick, every VISIBLE row.
 *
 * UNTICKING LEAVES THE HIDDEN ONES ALONE, which is the half worth stating.
 * Clearing the header box after a search would otherwise silently drop choices
 * made under a different search — taking away what somebody cannot see is the
 * same class of surprise as acting on it. The Clear button is the control that
 * empties everything, and it says so.
 */
export function setAllVisibleSelected(
  selected: ReadonlySet<string>,
  visibleIds: Iterable<string>,
  checked: boolean,
): Set<string> {
  const next = new Set(selected);
  for (const id of visibleIds) {
    if (checked) next.add(id);
    else next.delete(id);
  }
  return next;
}

export interface ResolvedSelection {
  /**
   * The chosen rows, in page order, and only those the page still has.
   *
   * DERIVED FROM `items` RATHER THAN READ OFF THE SET, which is what makes a
   * stale id harmless. After a bulk archive the page revalidates and the closed
   * sessions leave the list; anything still ticked that no longer exists stops
   * being counted and stops being acted on, with no effect racing the re-render
   * to prune it.
   */
  selectedItems: SelectableItem[];
  /** Chosen rows the current search or tab is not showing. Printed, never swallowed. */
  hiddenCount: number;
  /** Every visible row is chosen — the header box's checked state. */
  allVisibleSelected: boolean;
  /** Some but not all of them — the header box's "mixed" state. */
  someVisibleSelected: boolean;
}

export function resolveSelection(
  items: readonly SelectableItem[],
  selected: ReadonlySet<string>,
  visibleIds: ReadonlySet<string>,
): ResolvedSelection {
  const selectedItems = items.filter((i) => selected.has(i.id));
  const hiddenCount = selectedItems.reduce((n, i) => (visibleIds.has(i.id) ? n : n + 1), 0);
  const visibleSelected = selectedItems.length - hiddenCount;
  return {
    selectedItems,
    hiddenCount,
    allVisibleSelected: visibleIds.size > 0 && visibleSelected === visibleIds.size,
    someVisibleSelected: visibleSelected > 0 && visibleSelected < visibleIds.size,
  };
}
