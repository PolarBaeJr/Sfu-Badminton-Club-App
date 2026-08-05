'use client';

import { useState } from 'react';
import { Input, Select } from '@badminton/ui';

// The gyms the club actually books. Free text meant "West Gym", "west gym" and
// "West gym" all landed in the same column, so nothing could be grouped or
// counted by venue — and every session needed the name typed out again.
export const SESSION_LOCATIONS = ['West Gym', 'Central Gym'] as const;

const CUSTOM = '__custom__';

/**
 * The stored value stays a plain string, not an enum. Existing rows already
 * hold "West Gym" and must keep working untouched, and a one-off booking
 * elsewhere has to stay expressible — this is a convenience over the same
 * column, not a new constraint on it.
 */
export function LocationField({
  value,
  onChange,
}: {
  value: string;
  onChange: (next: string) => void;
}) {
  const isPreset = (SESSION_LOCATIONS as readonly string[]).includes(value);

  // Mode has to be real state, not derived. Derived from the value alone,
  // "nothing chosen yet" and "Custom chosen but not yet typed" are both the
  // empty string — so the custom box would appear before anyone picked Custom.
  //
  // Seeded from the value so EDITING works: a session already booked somewhere
  // off-list opens on Custom with the box filled, rather than looking unset.
  const [mode, setMode] = useState<'preset' | 'custom'>(
    value !== '' && !isPreset ? 'custom' : 'preset',
  );

  return (
    <div className="grid grid-cols-2 gap-3">
      <Select
        label="Location"
        required
        value={mode === 'custom' ? CUSTOM : (isPreset ? value : '')}
        onChange={(e) => {
          const next = e.target.value;
          if (next === CUSTOM) {
            setMode('custom');
            // Clear rather than carrying the preset across — "West Gym" sitting
            // in a box labelled Custom reads as if it were typed on purpose.
            onChange('');
            return;
          }
          setMode('preset');
          onChange(next);
        }}
        options={[
          { value: '', label: 'Select a location…' },
          ...SESSION_LOCATIONS.map((l) => ({ value: l, label: l })),
          { value: CUSTOM, label: 'Custom…' },
        ]}
      />
      {mode === 'custom' && (
        <Input
          label="Custom location"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder="e.g. Burnaby Lake Sports Complex"
          required
          autoFocus
        />
      )}
    </div>
  );
}
