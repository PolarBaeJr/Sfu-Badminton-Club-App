'use client';

import { useState } from 'react';
import { CTAButton } from '@/components/v2/atoms-form';
import { ChallengeSheet } from './challenge-sheet';

export function NewChallengeButton() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <CTAButton size="sm" onClick={() => setOpen(true)}>
        + New
      </CTAButton>
      <ChallengeSheet open={open} onClose={() => setOpen(false)} />
    </>
  );
}

export function SuggestedChallengeButton({ opponentId }: { opponentId: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        style={{
          width: '100%',
          height: 34,
          marginTop: 'auto',
          background: 'transparent',
          border: '1px solid var(--red)',
          color: 'var(--red)',
          fontSize: 10,
          fontWeight: 700,
          letterSpacing: '1.4px',
          textTransform: 'uppercase',
          cursor: 'pointer',
          fontFamily: 'inherit',
        }}
      >
        Challenge
      </button>
      <ChallengeSheet open={open} onClose={() => setOpen(false)} presetOpponentId={opponentId} />
    </>
  );
}
