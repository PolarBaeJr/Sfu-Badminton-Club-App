import React from 'react';
import { Textarea } from '@badminton/ui';

function Field({ children }: { children: React.ReactNode }) {
  return <div style={{ maxWidth: 440 }}>{children}</div>;
}

export function SessionNotes() {
  return (
    <Field>
      <Textarea
        label="Session notes"
        placeholder="Court conditions, drills covered, anything for next week…"
      />
    </Field>
  );
}

export function AnnouncementDraft() {
  return (
    <Field>
      <Textarea
        label="Announcement"
        rows={4}
        defaultValue={
          'Spring 2026 ladder starts Monday! Drop-in runs 7–10pm at Lorne Davies Complex. Comp fees are due before your first ranked match — see the Fees tab.'
        }
      />
    </Field>
  );
}

export function DisputeReasonError() {
  return (
    <Field>
      <Textarea
        label="Dispute reason"
        defaultValue="Score was 21-19 not 21-17"
        error="Please add at least 30 characters so admins can review"
      />
    </Field>
  );
}
