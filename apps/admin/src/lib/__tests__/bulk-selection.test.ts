import { describe, it, expect } from 'vitest';
import {
  resolveSelection,
  setAllVisibleSelected,
  toggleSelected,
  type SelectableItem,
} from '../selection-model';
import {
  MAX_BULK_TARGETS,
  mergeBulkOutcomes,
  normalizeBulkIds,
  runBulk,
} from '../bulk';
import type { ActionResult } from '../action-result';

// The multi-select on /players and /sessions, tested where its rules actually
// live: a plain module, because the console's suite runs with no DOM and a rule
// written inside the provider could not be reached at all.
//
// WHAT IS BEING PROTECTED. A selection is a list of people a single click is
// about to change, assembled across a search box and a 25-row window over a
// 500-row roster. The three ways that goes wrong are all here: choices lost to
// scrolling, "all" meaning something other than what the reader searched for,
// and — the one that matters — acting on somebody who is not on screen.

const ROSTER: SelectableItem[] = [
  { id: 'a', label: 'Ada Chen' },
  { id: 'b', label: 'Bao Chen' },
  { id: 'c', label: 'Kiera Wong' },
];
const ALL = new Set(['a', 'b', 'c']);

describe('what stays chosen', () => {
  it('keeps a row chosen after it stops being rendered', () => {
    // The roster mounts 25 rows at a time. If the selection lived in the
    // checkboxes, scrolling past row 25 would silently un-choose everyone above
    // it — and the officer would find out from a bulk action that skipped them.
    const selected = toggleSelected(new Set(), 'a');
    // 'a' has scrolled out: it is no longer visible, but it IS still on the page.
    const resolved = resolveSelection(ROSTER, selected, new Set(['b', 'c']));
    expect(resolved.selectedItems.map((i) => i.id)).toEqual(['a']);
  });

  it('forgets a row the page no longer has at all', () => {
    // After a bulk archive the page revalidates and the closed sessions leave
    // the list. A stale id must stop being counted and stop being acted on —
    // derived from `items` rather than from the Set, so no effect has to race
    // the re-render to prune it.
    const selected = new Set(['a', 'gone']);
    const resolved = resolveSelection(ROSTER, selected, ALL);
    expect(resolved.selectedItems.map((i) => i.id)).toEqual(['a']);
  });

  it('reports the chosen rows in page order, not in the order they were ticked', () => {
    const selected = toggleSelected(toggleSelected(new Set(), 'c'), 'a');
    expect(resolveSelection(ROSTER, selected, ALL).selectedItems.map((i) => i.id)).toEqual(['a', 'c']);
  });

  it('carries the labels, so a confirmation can name who it is about', () => {
    // "40 members" is a number an officer cannot check. The names are the whole
    // guard against a selection that outlived the search that built it.
    const selected = new Set(['a', 'c']);
    expect(resolveSelection(ROSTER, selected, ALL).selectedItems.map((i) => i.label))
      .toEqual(['Ada Chen', 'Kiera Wong']);
  });
});

describe('a search that hides a chosen row', () => {
  it('counts it out loud instead of quietly acting on it', () => {
    // Tick Ada, then search "wong". Ada is still selected — that is the useful
    // behaviour — so the bar has to say that one of the two is not on screen.
    const selected = new Set(['a', 'c']);
    const resolved = resolveSelection(ROSTER, selected, new Set(['c']));
    expect(resolved.selectedItems).toHaveLength(2);
    expect(resolved.hiddenCount).toBe(1);
  });

  it('is silent when everything chosen is on screen', () => {
    expect(resolveSelection(ROSTER, new Set(['a']), ALL).hiddenCount).toBe(0);
  });
});

describe('select all', () => {
  it('takes what the search matched, never the whole tab', () => {
    // The roster's list query is capped at 500 while the tab count is not, and
    // the window mounts 25 at a time. "All" is neither of those numbers.
    const searched = new Set(['a', 'b']);
    const selected = setAllVisibleSelected(new Set(), searched, true);
    expect([...selected].sort()).toEqual(['a', 'b']);
  });

  it('adds to what a previous search chose rather than replacing it', () => {
    const afterFirstSearch = new Set(['c']);
    const selected = setAllVisibleSelected(afterFirstSearch, new Set(['a', 'b']), true);
    expect([...selected].sort()).toEqual(['a', 'b', 'c']);
  });

  it('unticking leaves the rows the filter is hiding alone', () => {
    // Taking away what somebody cannot see is the same class of surprise as
    // acting on it. Clear is the control that empties everything.
    const selected = setAllVisibleSelected(new Set(['a', 'b', 'c']), new Set(['a']), false);
    expect([...selected].sort()).toEqual(['b', 'c']);
  });

  it('is checked only when every visible row is, and mixed in between', () => {
    const none = resolveSelection(ROSTER, new Set(), ALL);
    expect([none.allVisibleSelected, none.someVisibleSelected]).toEqual([false, false]);

    const some = resolveSelection(ROSTER, new Set(['a']), ALL);
    expect([some.allVisibleSelected, some.someVisibleSelected]).toEqual([false, true]);

    const all = resolveSelection(ROSTER, ALL, ALL);
    expect([all.allVisibleSelected, all.someVisibleSelected]).toEqual([true, false]);
  });

  it('is not checked when a search matched nothing', () => {
    // An empty visible set is vacuously "all selected" under a naive count, and
    // a ticked header box over an empty table reads as a selection nobody made.
    const resolved = resolveSelection(ROSTER, new Set(['a']), new Set());
    expect(resolved.allVisibleSelected).toBe(false);
    expect(resolved.someVisibleSelected).toBe(false);
  });
});

describe('the id list a bulk action is handed', () => {
  it('refuses an empty selection', () => {
    expect(() => normalizeBulkIds([])).toThrow(/nothing was selected/i);
  });

  it('refuses anything that is not a list of ids', () => {
    // Every exported argument of a server action is a client-controlled POST
    // field, so this is not defensive typing — it is the boundary.
    expect(() => normalizeBulkIds('a')).toThrow();
    expect(() => normalizeBulkIds([1, 2])).toThrow();
    expect(() => normalizeBulkIds([''])).toThrow();
  });

  it('acts on a repeated id once', () => {
    // Two audit rows for one edit is a record of something that did not happen.
    expect(normalizeBulkIds(['a', 'a', 'b'])).toEqual(['a', 'b']);
  });

  it('refuses more than one request may act on', () => {
    const many = Array.from({ length: MAX_BULK_TARGETS + 1 }, (_, i) => `p${i}`);
    expect(() => normalizeBulkIds(many)).toThrow(/at most/i);
  });
});

describe('walking the selection', () => {
  const ok = (): Promise<ActionResult<void>> => Promise.resolve({ ok: true, data: undefined });
  const no = (error: string): Promise<ActionResult<void>> => Promise.resolve({ ok: false, error });

  it('does not stop at the first refusal', () => {
    // Half a roster approved with four rows named is a usable outcome; an abort
    // on record three leaves the officer guessing about the rest.
    return runBulk(['a', 'b', 'c'], (id) => (id === 'b' ? no('Not a pending signup') : ok()))
      .then((outcome) => {
        expect(outcome).toEqual({
          attempted: 3,
          succeeded: 2,
          failures: [{ id: 'b', error: 'Not a pending signup' }],
        });
      });
  });

  it('runs them one after another, in the order the list was in', async () => {
    const seen: string[] = [];
    await runBulk(['a', 'b', 'c'], async (id) => {
      seen.push(`start:${id}`);
      await Promise.resolve();
      seen.push(`end:${id}`);
      return { ok: true, data: undefined };
    });
    expect(seen).toEqual(['start:a', 'end:a', 'start:b', 'end:b', 'start:c', 'end:c']);
  });

  it('keeps the action’s own wording for a refusal', () => {
    return runBulk(['a'], () => no('A banned member cannot be marked inactive'))
      .then((o) => expect(o.failures[0]!.error).toBe('A banned member cannot be marked inactive'));
  });
});

describe('folding the chunks the browser sends back', () => {
  it('adds the counts and keeps every failure', () => {
    expect(
      mergeBulkOutcomes([
        { attempted: 10, succeeded: 10, failures: [] },
        { attempted: 3, succeeded: 1, failures: [{ id: 'x', error: 'no' }, { id: 'y', error: 'no' }] },
      ]),
    ).toEqual({
      attempted: 13,
      succeeded: 11,
      failures: [{ id: 'x', error: 'no' }, { id: 'y', error: 'no' }],
    });
  });

  it('folds nothing into an empty outcome rather than throwing', () => {
    // The state a whole-operation failure on the FIRST chunk leaves behind.
    expect(mergeBulkOutcomes([])).toEqual({ attempted: 0, succeeded: 0, failures: [] });
  });
});
