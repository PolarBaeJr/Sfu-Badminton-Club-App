/**
 * Choosing several of something that is not a person.
 *
 * Sibling to player-selection.ts, and split from it for the reason that file is
 * split from player-search.ts: which options a query pulls up, which of them are
 * chosen, and what a CONTROL does with the answer are three questions. Only the
 * middle one has to say what happens when the same option is picked twice.
 *
 * WHAT IS REUSED RATHER THAN REWRITTEN. `selectableOptions` and `selectedOptions`
 * in player-selection.ts are already generic over `{ id: string }`, so
 * MultiSelect calls both of those instead of growing a second copy of "hide what
 * is chosen" and "chips in selection order". What is HERE is only the part they
 * cannot do: an option identified by `value` rather than `id`, the grouping the
 * role picker needs, the text match, and one toggle covering both directions.
 *
 * Plain .ts, no React, so the behaviour can be tested without rendering
 * anything. Every function returns a NEW array: the control hands its result
 * straight to a caller's setState, and mutating an array the parent still holds
 * is how a React list silently fails to re-render.
 */

export interface MultiSelectOption {
  value: string;
  label: string;
  /**
   * A heading to file this option under. Options with no group are listed
   * first, ungrouped, so a caller that does not care about grouping gets a flat
   * list without opting into anything.
   */
  group?: string;
}

/**
 * `{ id }` is what player-selection.ts's two generic helpers key on, and an
 * option here is keyed on `value`. Adapting is one line and keeps ONE answer to
 * "what happens when the same thing is picked twice" in the repo.
 */
function asIdentified(option: MultiSelectOption): MultiSelectOption & { id: string } {
  return { ...option, id: option.value };
}

/** Every option, in the shape the two generic helpers in player-selection want. */
export function identifiedOptions(
  options: MultiSelectOption[],
): (MultiSelectOption & { id: string })[] {
  return options.map(asIdentified);
}

/**
 * Case- and space-insensitive substring match on the LABEL, and nothing else.
 *
 * Not on `value`: for the role picker the value is a name the writer typed and
 * the label is what Discord shows, and matching a hidden field makes a list
 * that filters on something invisible. Not ranked either, unlike
 * filterPlayerOptions: these lists are tens of entries, not a roster, and a
 * stable alphabetical order is easier to scan than a relevance order that
 * reshuffles on every keystroke.
 */
export function filterMultiSelectOptions(
  options: MultiSelectOption[],
  query: string,
): MultiSelectOption[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [...options];
  return options.filter((o) => o.label.toLowerCase().includes(needle));
}

/**
 * The list broken into the headings it will be drawn under, IN THE ORDER THE
 * OPTIONS ARRIVED.
 *
 * Order is the caller's to decide and is never sorted here: the notify picker
 * wants the club's nine roles above the server's, which is not alphabetical and
 * is not the order a Set of group names would produce if it were built by
 * accident. A group with nothing left in it after filtering is dropped rather
 * than rendered as an empty heading.
 */
export function groupMultiSelectOptions(
  options: MultiSelectOption[],
): { group: string | null; options: MultiSelectOption[] }[] {
  const out: { group: string | null; options: MultiSelectOption[] }[] = [];
  const byGroup = new Map<string | null, MultiSelectOption[]>();

  for (const option of options) {
    const key = option.group ?? null;
    const bucket = byGroup.get(key);
    if (bucket) {
      bucket.push(option);
      continue;
    }
    const fresh = [option];
    byGroup.set(key, fresh);
    out.push({ group: key, options: fresh });
  }

  return out;
}

/**
 * Toggle one option: picked if it was not, dropped if it was.
 *
 * ONE FUNCTION FOR BOTH DIRECTIONS, and the control uses it for both: the list
 * only ever adds, because it hides what is already chosen, and a chip's remove
 * button only ever removes. Writing those as two calls would leave the question
 * "what happens when the same option arrives twice" answered in two places.
 * Appends rather than sorts, so the chips read in the order they were picked.
 */
export function toggleValue(selected: string[], value: string): string[] {
  if (!value) return [...selected];
  if (selected.includes(value)) return selected.filter((v) => v !== value);
  return [...selected, value];
}
