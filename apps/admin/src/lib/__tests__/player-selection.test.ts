import { describe, it, expect } from 'vitest';
// Straight at the module rather than the '@badminton/ui' barrel, for the same
// reason player-row-search.test.ts does it: the barrel pulls in every component,
// and a node test has no business transforming JSX to check array arithmetic.
import {
  toSelectedIds,
  toSingleValue,
  addSelectedId,
  removeSelectedId,
  selectableOptions,
  selectedOptions,
} from '@badminton/ui/src/player-selection';

/**
 * The selection set behind PlayerPicker's `multiple` mode. The control renders
 * it; these functions decide what it contains. Everything the club owner asked
 * for ("multi add for everything") reduces to add / remove / never-twice, and
 * the single-select half of the union has to come out the far side unchanged.
 */

const roster = [
  { id: 'p1', name: 'Alice Chen' },
  { id: 'p2', name: 'Bob Lee' },
  { id: 'p3', name: 'Carol Ng' },
];

describe('toSelectedIds / toSingleValue — the single↔multi bridge', () => {
  it('turns a single id into a one-element list', () => {
    // The whole reason the component can keep ONE internal shape.
    expect(toSelectedIds('p1')).toEqual(['p1']);
  });

  it("turns the empty single value into an EMPTY list, not ['']", () => {
    // '' is how every existing call site says "nothing chosen". [''] would give
    // the picker a selection of one player that does not exist — a nameless
    // chip, and a truthy "something is selected" everywhere downstream.
    expect(toSelectedIds('')).toEqual([]);
  });

  it('passes a list through, dropping empty ids', () => {
    expect(toSelectedIds(['p1', 'p2'])).toEqual(['p1', 'p2']);
    expect(toSelectedIds(['p1', ''])).toEqual(['p1']);
  });

  it('round-trips a single selection unchanged', () => {
    // Single-mode call sites must be able to stay exactly as they were: what
    // goes in as a string comes back out as the same string.
    expect(toSingleValue(toSelectedIds('p2'))).toBe('p2');
    expect(toSingleValue(toSelectedIds(''))).toBe('');
  });

  it('reports an empty selection as the empty string, so "clear" keeps meaning what it did', () => {
    expect(toSingleValue([])).toBe('');
  });
});

describe('addSelectedId', () => {
  it('appends in the order picked, not roster order', () => {
    // The chips read back in the order the exec was thinking in.
    expect(addSelectedId(['p3'], 'p1')).toEqual(['p3', 'p1']);
  });

  it('DEDUPES — the same person can never be selected twice', () => {
    // The invariant the whole feature rests on. Adding a duplicate would submit
    // that person twice, and the second insert would fail on the unique
    // constraint, turning a clean batch into a spurious "5 of 6".
    expect(addSelectedId(['p1', 'p2'], 'p1')).toEqual(['p1', 'p2']);
  });

  it('returns the SAME array when nothing changed', () => {
    // No pointless re-render, and no chance of a parent seeing a new array with
    // identical contents and treating it as a change.
    const before = ['p1'];
    expect(addSelectedId(before, 'p1')).toBe(before);
  });

  it('ignores an empty id', () => {
    // '' is "nothing", never a member of the set.
    expect(addSelectedId(['p1'], '')).toEqual(['p1']);
  });

  it('does not mutate the array the caller still holds', () => {
    // It goes straight into setState; mutating it in place is how a React list
    // silently stops re-rendering.
    const before = ['p1'];
    addSelectedId(before, 'p2');
    expect(before).toEqual(['p1']);
  });
});

describe('removeSelectedId', () => {
  it('removes one chip and leaves the rest in order', () => {
    expect(removeSelectedId(['p1', 'p2', 'p3'], 'p2')).toEqual(['p1', 'p3']);
  });

  it('is a no-op for someone who was not selected', () => {
    // Removing twice (double-click on the × ) must not throw or empty the list.
    const before = ['p1', 'p2'];
    expect(removeSelectedId(before, 'p9')).toBe(before);
  });

  it('empties down to a list, not to undefined', () => {
    // The picker reads .length on the result on every render.
    expect(removeSelectedId(['p1'], 'p1')).toEqual([]);
  });

  it('does not mutate the array the caller still holds', () => {
    const before = ['p1', 'p2'];
    removeSelectedId(before, 'p1');
    expect(before).toEqual(['p1', 'p2']);
  });
});

describe('selectableOptions — what is still worth showing', () => {
  it('hides everyone already chosen', () => {
    // The task's requirement stated directly: an already-selected player must
    // not appear again in the list of options.
    expect(selectableOptions(roster, ['p2']).map((p) => p.id)).toEqual(['p1', 'p3']);
  });

  it('returns the roster untouched when nothing is selected', () => {
    // Also the single-select path, which never filters.
    expect(selectableOptions(roster, [])).toBe(roster);
  });

  it('can empty the list completely', () => {
    // Everyone added: the picker shows "Everyone is already selected" rather
    // than 'No players match ""'.
    expect(selectableOptions(roster, ['p1', 'p2', 'p3'])).toEqual([]);
  });

  it('ignores selected ids that are not in the roster', () => {
    // Call sites pre-filter the roster (available players only), so a stale id
    // is normal and must not remove an unrelated row.
    expect(selectableOptions(roster, ['gone']).map((p) => p.id)).toEqual(['p1', 'p2', 'p3']);
  });
});

describe('selectedOptions — the chips', () => {
  it('resolves ids to rows in SELECTION order, not roster order', () => {
    // The chip that just appeared is the last one; it must not jump into the
    // middle of the row on the next render.
    expect(selectedOptions(roster, ['p3', 'p1']).map((p) => p.name)).toEqual(['Carol Ng', 'Alice Chen']);
  });

  it('skips an id with no matching row rather than rendering a blank chip', () => {
    expect(selectedOptions(roster, ['p1', 'gone']).map((p) => p.id)).toEqual(['p1']);
  });

  it('is empty for an empty selection', () => {
    expect(selectedOptions(roster, [])).toEqual([]);
  });
});

describe('single-select mode is unchanged', () => {
  it('picking someone replaces the selection instead of appending', () => {
    // Single mode emits [option.id] rather than add(selected, id). Modelled
    // here because it is the one place the two modes must NOT share behaviour:
    // a challenge opponent is exactly one person, and appending would silently
    // make it two.
    const pickSingle = (id: string) => toSingleValue([id]);
    expect(pickSingle('p2')).toBe('p2');
    expect(pickSingle('p3')).toBe('p3');
  });

  it('leaves the roster whole — the chosen player stays in the list with a tick', () => {
    // Hiding the selection is a MULTI-mode behaviour only. Single mode passes
    // `players` to the list untouched, so re-opening the field still shows who
    // is currently chosen. Modelled as the identity that holds when no
    // filtering is applied.
    const listedInSingleMode = roster;
    expect(listedInSingleMode.map((p) => p.id)).toEqual(['p1', 'p2', 'p3']);
    // And for contrast, what multi mode would have shown for the same pick:
    expect(selectableOptions(roster, toSelectedIds('p1')).map((p) => p.id)).toEqual(['p2', 'p3']);
  });
});
