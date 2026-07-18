import React from 'react';
import { Select } from '@badminton/ui';

function Field({ children }: { children: React.ReactNode }) {
  return <div style={{ maxWidth: 380 }}>{children}</div>;
}

export function SeasonPicker() {
  return (
    <Field>
      <Select
        label="Season"
        defaultValue="spring-2026"
        options={[
          { value: 'fall-2025', label: 'Fall 2025' },
          { value: 'spring-2026', label: 'Spring 2026' },
          { value: 'summer-2026', label: 'Summer 2026' },
        ]}
      />
    </Field>
  );
}

export function DivisionError() {
  return (
    <Field>
      <Select
        label="Skill division"
        defaultValue=""
        error="Pick a division before joining the ladder"
        options={[
          { value: '', label: 'Select a division…' },
          { value: 'comp', label: 'Competitive' },
          { value: 'rec', label: 'Recreational' },
        ]}
      />
    </Field>
  );
}

export function DisabledVenue() {
  return (
    <Field>
      <Select
        label="Venue"
        disabled
        options={[{ value: 'ldc', label: 'Lorne Davies Complex — Court 3' }]}
      />
    </Field>
  );
}
