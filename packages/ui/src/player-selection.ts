/**
 * Choosing people — the selection SET, not the matching and not the control.
 *
 * Sibling to player-search.ts, and split from it for the reason that file's own
 * header gives: it is about "the matching, not the control". Which names a query
 * pulls up and which people an exec has picked are different questions, and only
 * the second one has to answer "what happens when the same person is picked
 * twice".
 *
 * Plain .ts, no React, so PlayerPicker's multi-select behaviour can be tested
 * without rendering anything. Every function returns a NEW array — the picker
 * hands its result straight to a caller's setState, and mutating the array a
 * parent still holds is how a React list silently fails to re-render.
 */

/**
 * The one place single- and multi-select meet. PlayerPicker keeps a `string[]`
 * internally whichever mode it is in, so the single path stays exactly what it
 * always was from the caller's side while the component below has one shape to
 * reason about.
 *
 * '' means "nothing chosen yet" in single mode, and must become an EMPTY list —
 * not `['']`, which would make an empty picker look like it had a selection and
 * render a chip for a player that does not exist.
 */
export function toSelectedIds(value: string | string[]): string[] {
  if (Array.isArray(value)) return value.filter(Boolean);
  return value ? [value] : [];
}

/**
 * The inverse, for handing a single-select caller back the `string` its
 * `onChange` is typed for. An empty selection is '', which is what every
 * existing call site already treats as "cleared".
 */
export function toSingleValue(ids: string[]): string {
  return ids[0] ?? '';
}

/**
 * Add someone, idempotently. A duplicate id is dropped rather than appended:
 * the same person cannot be added to a tournament twice, so a list that
 * contained them twice could only ever produce a spurious "1 of 2 failed".
 * Appends rather than sorts — the chips read in the order the exec picked them,
 * which is the order they are thinking in.
 */
export function addSelectedId(selected: string[], id: string): string[] {
  if (!id || selected.includes(id)) return selected;
  return [...selected, id];
}

/** Remove someone. Removing an id that is not selected is a no-op, not an error. */
export function removeSelectedId(selected: string[], id: string): string[] {
  if (!selected.includes(id)) return selected;
  return selected.filter((s) => s !== id);
}

/**
 * The options still worth showing: everyone not already chosen. Hiding them
 * beats showing them with a tick, because in multi mode clicking a row means
 * "add", and a row that cannot be added is a dead target.
 */
export function selectableOptions<T extends { id: string }>(options: T[], selected: string[]): T[] {
  if (selected.length === 0) return options;
  const taken = new Set(selected);
  return options.filter((o) => !taken.has(o.id));
}

/**
 * The chosen options as full rows, in SELECTION order rather than roster order,
 * so the chip that just appeared is the last one and does not jump into the
 * middle of the row. Ids with no matching option are skipped: a roster can be
 * filtered by the caller (available players only) and a stale id must not
 * render a nameless chip.
 */
export function selectedOptions<T extends { id: string }>(options: T[], selected: string[]): T[] {
  const byId = new Map(options.map((o) => [o.id, o]));
  return selected.map((id) => byId.get(id)).filter((o): o is T => o !== undefined);
}
