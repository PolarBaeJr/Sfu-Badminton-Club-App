import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
// Straight at the modules rather than the '@badminton/ui' barrel, for the reason
// player-selection.test.ts gives: the barrel pulls in every component in the
// package, and most of this file is checking array arithmetic.
import {
  filterMultiSelectOptions,
  groupMultiSelectOptions,
  identifiedOptions,
  toggleValue,
  type MultiSelectOption,
} from '@badminton/ui/src/multi-select';
import { selectableOptions, selectedOptions } from '@badminton/ui/src/player-selection';
import { MultiSelect } from '@badminton/ui/src/components/MultiSelect';

/**
 * The set arithmetic behind MultiSelect, and one render to prove the control
 * itself still draws.
 *
 * TESTED HERE AND NOT IN packages/ui BECAUSE THAT PACKAGE HAS NO TEST SCRIPT AND
 * NO VITEST. The same call player-selection.test.ts made, and it is why the logic
 * lives in a React-free module in the first place: a suite that does not run
 * proves nothing, and the notify picker is the one control in the console whose
 * mistake is a notification the club cannot take back.
 */

const OPTIONS: MultiSelectOption[] = [
  { value: 'internal', label: 'internal', group: 'Club roles' },
  { value: 'session_staff', label: 'session_staff', group: 'Club roles' },
  { value: 'Varsity', label: 'Varsity', group: 'Server roles' },
  { value: 'Session Pings', label: 'Session Pings', group: 'Server roles' },
];

describe('toggleValue', () => {
  it('adds what was not there, in pick order', () => {
    expect(toggleValue([], 'internal')).toEqual(['internal']);
    expect(toggleValue(['internal'], 'Varsity')).toEqual(['internal', 'Varsity']);
  });

  it('REMOVES what was already picked, which is what makes it a toggle', () => {
    // The property the control relies on for both directions: a list row adds and
    // a chip's × removes, through one function. Two functions would be two answers
    // to "what happens when the same option arrives twice".
    expect(toggleValue(['internal', 'Varsity'], 'internal')).toEqual(['Varsity']);
  });

  it('returns a NEW array every time', () => {
    // The result goes straight to setState. Mutating the array the parent still
    // holds is how a React list silently fails to re-render.
    const before = ['internal'];
    expect(toggleValue(before, 'Varsity')).not.toBe(before);
    expect(toggleValue(before, 'internal')).not.toBe(before);
    expect(toggleValue(before, '')).not.toBe(before);
    expect(before).toEqual(['internal']);
  });

  it('ignores an empty value rather than picking a nameless option', () => {
    expect(toggleValue(['internal'], '')).toEqual(['internal']);
  });
});

describe('filterMultiSelectOptions', () => {
  it('matches on the label, ignoring case and outer space', () => {
    expect(filterMultiSelectOptions(OPTIONS, ' VARS ').map((o) => o.value)).toEqual(['Varsity']);
  });

  it('hands back everything when nothing is typed', () => {
    expect(filterMultiSelectOptions(OPTIONS, '')).toHaveLength(OPTIONS.length);
    // A copy, not the caller's array.
    expect(filterMultiSelectOptions(OPTIONS, '')).not.toBe(OPTIONS);
  });

  it("keeps the caller's order rather than ranking", () => {
    // Unlike filterPlayerOptions: these lists are tens of entries, and an order
    // that reshuffles on every keystroke is harder to scan than a fixed one.
    expect(filterMultiSelectOptions(OPTIONS, 'session').map((o) => o.value)).toEqual([
      'session_staff',
      'Session Pings',
    ]);
  });
});

describe('groupMultiSelectOptions', () => {
  it('keeps the groups in the order the options arrived', () => {
    // Never sorted: the notify picker wants the club's roles ABOVE the server's,
    // which is not alphabetical.
    expect(groupMultiSelectOptions(OPTIONS).map((g) => g.group)).toEqual([
      'Club roles',
      'Server roles',
    ]);
  });

  it('drops a group with nothing left in it after filtering', () => {
    const filtered = filterMultiSelectOptions(OPTIONS, 'varsity');
    expect(groupMultiSelectOptions(filtered).map((g) => g.group)).toEqual(['Server roles']);
  });

  it('files ungrouped options under null rather than inventing a heading', () => {
    const groups = groupMultiSelectOptions([{ value: 'a', label: 'A' }]);
    expect(groups).toEqual([{ group: null, options: [{ value: 'a', label: 'A' }] }]);
  });
});

describe('the two helpers reused from player-selection', () => {
  it('hides what is already chosen and lists the chips in pick order', () => {
    // Reused rather than reimplemented: both are already generic over
    // `{ id: string }`, and `identifiedOptions` is the one line that adapts an
    // option keyed on `value` to them.
    const keyed = identifiedOptions(OPTIONS);

    expect(selectableOptions(keyed, ['internal']).map((o) => o.value)).toEqual([
      'session_staff',
      'Varsity',
      'Session Pings',
    ]);
    expect(selectedOptions(keyed, ['Varsity', 'internal']).map((o) => o.label)).toEqual([
      'Varsity',
      'internal',
    ]);
  });

  it('skips a selected value that names no option', () => {
    // A role deleted in Discord between the page loading and the catalogue
    // syncing. A chip with no label on it would be worse than none.
    expect(selectedOptions(identifiedOptions(OPTIONS), ['gone'])).toEqual([]);
  });
});

describe('MultiSelect renders', () => {
  // renderToStaticMarkup, because this app's vitest is `environment: 'node'`:
  // the same limit discord-preview.test.tsx works within. It is a smoke test and
  // nothing more. The list is portalled and only mounts client-side, so what is
  // asserted here is the field, the chips and the help text.
  //
  // READ THE BLOCK BELOW THIS ONE BEFORE TRUSTING THAT SENTENCE. An earlier
  // version of this comment stopped here, and it read as a reason the dropdown
  // could not be checked. The dropdown was in fact missing entirely, and these
  // four assertions all passed against a control that never drew a list.
  const draw = () =>
    renderToStaticMarkup(
      <MultiSelect
        id="discord-notify"
        label="Notify"
        value={['Varsity']}
        onChange={() => {}}
        options={OPTIONS}
        helpText="Nobody is notified."
      />,
    );

  it('draws the field under the id it was given, not one derived from the label', () => {
    // The reason `id` is required on this component: both composers are mounted
    // at once in the same card, and an id derived from label text has already
    // collided once on this page.
    const html = draw();
    expect(html).toContain('id="discord-notify"');
    expect(html).toContain('for="discord-notify"');
  });

  it('draws a chip for what is picked, with a way to take it off', () => {
    expect(draw()).toContain('Remove Varsity');
  });

  it('says nothing about players anywhere', () => {
    // NOT PlayerPicker WITH ROLES PUSHED THROUGH IT. Its avatar initials, its "No
    // players match" and its aria-label="Players" would each lie about what is
    // being picked here.
    expect(draw().toLowerCase()).not.toContain('player');
  });

  it('carries the help text, which is where the ping warning lives', () => {
    expect(draw()).toContain('Nobody is notified.');
  });
});

describe('MultiSelect actually mounts its listbox', () => {
  /**
   * A SOURCE ASSERTION, DELIBERATELY, AND THE REASON IS NOT LAZINESS.
   *
   * MultiSelect shipped once with `const list = ...` built and never rendered:
   * createPortal was imported and never called. The control focused, the chevron
   * turned, aria-expanded flipped to true, and no list ever appeared. It replaced
   * nine working checkboxes, so an exec could not pick a notify role by mouse or
   * touch at all.
   *
   * NOTHING IN THIS REPO COULD HAVE CAUGHT IT:
   *   - tsconfig.base.json sets no noUnusedLocals, so tsc is silent on both the
   *     dead binding and the unused import.
   *   - this app's vitest is environment: 'node' and there is no jsdom or
   *     testing-library in the tree, so no test can mount the component.
   *   - renderToStaticMarkup could never reach it even with a DOM: the portal is
   *     guarded by `mounted`, which is false until an effect runs, so a server
   *     render correctly draws no list whether or not the line exists.
   *
   * So this reads the file. It is a tripwire on one exact line, not a test of
   * behaviour, and it is honest about which of those it is. Delete it the day
   * this package gets a DOM environment and a real open-the-dropdown test.
   */
  const source = readFileSync(
    resolve(__dirname, '../../../../../packages/ui/src/components/MultiSelect.tsx'),
    'utf8',
  );

  it('renders the listbox it builds, instead of leaving it as dead JSX', () => {
    expect(source).toContain('createPortal(list, document.body)');
  });

  it('still guards the portal on `mounted`, so a server render draws no list', () => {
    // Without the guard, renderToStaticMarkup throws: the server renderer has no
    // document.body. The smoke tests above would fail loudly rather than subtly,
    // but the guard is what makes them meaningful in the first place.
    expect(source).toContain('{mounted && list && createPortal(list, document.body)}');
  });
});
