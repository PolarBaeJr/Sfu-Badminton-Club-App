'use client';

// THE ONE PRESENTATION OF AN EVENT WAIVER, and the one place the member says
// yes to it.
//
// This markup was already written twice, verbatim, in EventRegistrationButton
// and EventActions — the registration dialog. It is now written once, and the
// third caller is the new one: the panel a member sees when an EXEC added them
// and nobody ever asked. Reusing the presentation is not tidiness here, it is
// the point: the person being asked to sign at the door must be reading the
// same thing, in the same box, as the person who signed themselves up.
//
// A SCROLLING BOX, NOT A COLLAPSED SUMMARY. The text has to be in front of them
// — an acceptance recorded against wording the member could not see is the
// laundering problem in a different coat.

import { LegalMarkdown } from '@badminton/ui';

export function EventWaiverConsent({
  text,
  accepted,
  onAcceptedChange,
}: {
  text: string;
  accepted: boolean;
  onAcceptedChange: (value: boolean) => void;
}) {
  return (
    <>
      <div
        style={{
          maxHeight: '50vh',
          overflowY: 'auto',
          border: '1px solid var(--line)',
          borderRadius: 10,
          padding: 14,
        }}
      >
        <LegalMarkdown content={text} />
      </div>
      <label
        style={{
          display: 'flex',
          alignItems: 'flex-start',
          gap: 10,
          fontSize: 13,
          lineHeight: 1.5,
          cursor: 'pointer',
        }}
      >
        <input
          type="checkbox"
          checked={accepted}
          onChange={(e) => onAcceptedChange(e.target.checked)}
          style={{ marginTop: 2, accentColor: 'var(--red)', flexShrink: 0 }}
        />
        <span>I have read and accept the event waiver.</span>
      </label>
    </>
  );
}
