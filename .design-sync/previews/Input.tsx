import React from 'react';
import { Input } from '@badminton/ui';

// Constrain full-width inputs so they read as form fields, not 900px bars.
function Field({ children }: { children: React.ReactNode }) {
  return <div style={{ maxWidth: 380 }}>{children}</div>;
}

export function PlayerName() {
  return (
    <Field>
      <Input label="Player name" placeholder="e.g. Wei Chen" />
    </Field>
  );
}

export function StartingElo() {
  return (
    <Field>
      <Input label="Starting ELO" type="number" defaultValue={612} />
    </Field>
  );
}

export function EmailError() {
  return (
    <Field>
      <Input
        label="SFU email"
        defaultValue="wkc10@sfu"
        error="Enter a valid SFU email address (…@sfu.ca)"
      />
    </Field>
  );
}

export function DisabledMemberId() {
  return (
    <Field>
      <Input label="Member ID" defaultValue="SFU-2026-0117" disabled />
    </Field>
  );
}
