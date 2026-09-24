import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
// Straight at the modules rather than the '@badminton/ui' barrel, for the reason
// multi-select.test.tsx gives: the barrel pulls in every component in the
// package, and most of this file is checking index arithmetic.
import {
  indexOfValue,
  initialActiveIndex,
  nextEnabledIndex,
  resolvePlacement,
  shouldEmitChange,
  typeaheadMatch,
  type SelectOption,
} from '@badminton/ui/src/select';
import { Select } from '@badminton/ui/src/components/Select';

/**
 * The rules behind the shared single-value Select, one render to prove the
 * control still draws, and source tripwires for the lines no node test can
 * reach. Tested here and not in packages/ui because that package has no test
 * script, the same call multi-select.test.tsx made.
 */

const LOCATIONS: SelectOption[] = [
  { value: '', label: 'Select a location' },
  { value: 'west', label: 'West Gym' },
  { value: 'central', label: 'Central Gym' },
  { value: 'custom', label: 'Custom…' },
];

const WITH_DISABLED: SelectOption[] = [
  { value: 'a', label: 'Alpha', disabled: true },
  { value: 'b', label: 'Bravo' },
  { value: 'c', label: 'Charlie', disabled: true },
  { value: 'd', label: 'Delta' },
  { value: 'e', label: 'Echo', disabled: true },
];

describe('indexOfValue', () => {
  it('finds the option holding the value', () => {
    expect(indexOfValue(LOCATIONS, 'central')).toBe(2);
  });

  it('returns -1 for an empty value no option holds, instead of claiming the first option', () => {
    // The tournament fee and member edit forms hold '' before anything is
    // chosen; the native control painted options[0] over it and lied.
    const noEmpty = LOCATIONS.slice(1);
    expect(indexOfValue(noEmpty, '')).toBe(-1);
    expect(indexOfValue(noEmpty, undefined)).toBe(-1);
  });
});

describe('initialActiveIndex', () => {
  it('starts on the selection when it can be picked', () => {
    expect(initialActiveIndex(WITH_DISABLED, 'd')).toBe(3);
  });

  it('falls back to the first enabled option when the value is unmatched or disabled', () => {
    expect(initialActiveIndex(WITH_DISABLED, 'zzz')).toBe(1);
    expect(initialActiveIndex(WITH_DISABLED, 'c')).toBe(1);
  });
});

describe('nextEnabledIndex', () => {
  it('skips disabled options in both directions', () => {
    expect(nextEnabledIndex(WITH_DISABLED, 1, 1)).toBe(3);
    expect(nextEnabledIndex(WITH_DISABLED, 3, -1)).toBe(1);
  });

  it('clamps at the ends without wrap, as a native listbox does', () => {
    expect(nextEnabledIndex(WITH_DISABLED, 3, 1)).toBe(3);
    expect(nextEnabledIndex(WITH_DISABLED, 1, -1)).toBe(1);
  });

  it('wraps when asked', () => {
    expect(nextEnabledIndex(WITH_DISABLED, 3, 1, true)).toBe(1);
  });

  it('treats -1 as nothing active: down gives the first enabled, up the last', () => {
    expect(nextEnabledIndex(WITH_DISABLED, -1, 1)).toBe(1);
    expect(nextEnabledIndex(WITH_DISABLED, -1, -1)).toBe(3);
  });

  it('returns -1 when every option is disabled', () => {
    const none = WITH_DISABLED.map((o) => ({ ...o, disabled: true }));
    expect(nextEnabledIndex(none, -1, 1)).toBe(-1);
    expect(nextEnabledIndex(none, 0, 1)).toBe(-1);
  });
});

describe('typeaheadMatch', () => {
  it('matches a label prefix case-insensitively', () => {
    expect(typeaheadMatch(LOCATIONS, 'W', -1)).toBe(1);
  });

  it('searches from the row after the current one and wraps', () => {
    expect(typeaheadMatch(LOCATIONS, 'w', 1)).toBe(1);
    expect(typeaheadMatch(LOCATIONS, 's', 2)).toBe(0);
  });

  it('cycles through rows sharing a first letter when one letter is repeated', () => {
    const first = typeaheadMatch(LOCATIONS, 'c', -1);
    expect(first).toBe(2);
    expect(typeaheadMatch(LOCATIONS, 'cc', first)).toBe(3);
    expect(typeaheadMatch(LOCATIONS, 'cc', 3)).toBe(2);
  });

  it('matches a buffer with a space in it', () => {
    expect(typeaheadMatch(LOCATIONS, 'west g', 1)).toBe(1);
    expect(typeaheadMatch(LOCATIONS, 'central g', -1)).toBe(2);
  });

  it('skips disabled options', () => {
    expect(typeaheadMatch(WITH_DISABLED, 'a', -1)).toBe(-1);
  });

  it('returns -1 when nothing matches', () => {
    expect(typeaheadMatch(LOCATIONS, 'x', -1)).toBe(-1);
  });
});

describe('shouldEmitChange', () => {
  it('stays silent on a re-pick, so re-choosing Custom does not wipe a typed location', () => {
    // LocationField calls onChange('') when Custom is picked, which clears the
    // free-text box. A native select never fires change on a re-pick, and the
    // custom control must not either.
    expect(shouldEmitChange('custom', 'custom')).toBe(false);
  });

  it('reports a real change', () => {
    expect(shouldEmitChange('west', 'custom')).toBe(true);
    expect(shouldEmitChange(undefined, '')).toBe(true);
  });
});

describe('resolvePlacement', () => {
  const viewport = { width: 1000, height: 800 };
  const opts = { gap: 6, maxHeight: 288, minHeight: 120, margin: 8 };

  it('opens below with the trigger width when there is room', () => {
    const p = resolvePlacement({ top: 100, bottom: 148, left: 50, width: 240 }, viewport, opts);
    expect(p.top).toBe(154);
    expect(p.bottom).toBeUndefined();
    expect(p.minWidth).toBe(240);
    expect(p.left).toBe(50);
    expect(p.maxHeight).toBe(288);
  });

  it('flips up near the bottom of the viewport', () => {
    const p = resolvePlacement({ top: 700, bottom: 748, left: 50, width: 240 }, viewport, opts);
    expect(p.top).toBeUndefined();
    expect(p.bottom).toBe(800 - 700 + 6);
  });

  it('pulls the list back inside the right edge', () => {
    const p = resolvePlacement({ top: 100, bottom: 148, left: 900, width: 240 }, viewport, opts);
    expect(p.left).toBe(1000 - 8 - 240);
  });

  it('floors the height at minHeight', () => {
    const p = resolvePlacement(
      { top: 60, bottom: 108, left: 50, width: 240 },
      { width: 1000, height: 180 },
      opts,
    );
    expect(p.maxHeight).toBe(120);
  });
});

describe('Select render', () => {
  const GYMS = LOCATIONS.slice(1);

  it('draws a labelled listbox trigger', () => {
    const html = renderToStaticMarkup(
      <Select label="Location" value="west" options={GYMS} onChange={() => {}} />,
    );
    expect(html).toContain('aria-haspopup="listbox"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('Location');
    expect(html).toContain('for="location"');
    expect(html).toContain('id="location"');
    expect(html).toContain('West Gym');
  });

  it('shows the placeholder, not the first option, when the value matches nothing', () => {
    const html = renderToStaticMarkup(
      <Select label="Location" value="" placeholder="Pick a gym" options={GYMS} onChange={() => {}} />,
    );
    expect(html).toContain('Pick a gym');
    // Closed and server-rendered, so no list is drawn: any option label in the
    // output would have come from the trigger.
    expect(html).not.toContain('West Gym');
  });

  it('renders a plain select when asked to stay native', () => {
    const html = renderToStaticMarkup(
      <Select native label="Location" value="west" options={GYMS} onChange={() => {}} />,
    );
    expect(html).toContain('<select');
  });

  it('mirrors name and required into an input a form can validate and post', () => {
    const html = renderToStaticMarkup(
      <Select label="Location" name="location" required value="" options={GYMS} onChange={() => {}} />,
    );
    expect(html).toMatch(/<input[^>]*name="location"/);
    expect(html).toMatch(/<input[^>]*required/);
    expect(html).not.toMatch(/<input[^>]*type="hidden"/);
  });
});

describe('Select source tripwires', () => {
  /**
   * Source assertions, for the reason multi-select.test.tsx gives at length:
   * this app's vitest has no DOM, and a server render cannot reach the portal,
   * so these lines are otherwise unguarded.
   */
  const source = readFileSync(
    resolve(__dirname, '../../../../../packages/ui/src/components/Select.tsx'),
    'utf8',
  );

  it('renders the listbox it builds, guarded on mounted', () => {
    expect(source).toContain('{mounted && list && createPortal(list, document.body)}');
  });

  it('stops Escape reaching the Dialog listener on document', () => {
    expect(source).toContain('nativeEvent.stopImmediatePropagation()');
  });

  it('keeps focus on the trigger and points at the active row', () => {
    expect(source).toContain('aria-activedescendant');
  });

  it('keeps tabindex -1 elements out of the Dialog focus trap', () => {
    const dialog = readFileSync(
      resolve(__dirname, '../../../../../packages/ui/src/components/Dialog.tsx'),
      'utf8',
    );
    expect(dialog).toContain('input:not([disabled]):not([tabindex="-1"])');
  });
});
